import { z } from 'zod';
import { isVaultSearchable } from './vaultMap';

/** The fenced block an agent answers with. The plugin reads only this block; the agent moves nothing itself. */
const BLOCK = /```agenthq-reorg[ \t]*\n([\s\S]*?)\n```/g;
/** Plans and undo logs stay small enough to review: at most this many moves per plan. */
export const MAX_MOVES = 500;

export interface Move {
  from: string;
  to: string;
  reason: string;
}
export interface Merge {
  keep: string;
  merge: string;
  reason: string;
}
export interface Plan {
  structure: string[];
  moves: Move[];
  merges: Merge[];
}

const planSchema = z.object({
  structure: z.array(z.string()).default([]),
  moves: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        reason: z.string().default(''),
      }),
    )
    .max(MAX_MOVES)
    .default([]),
  merges: z
    .array(
      z.object({
        keep: z.string().min(1),
        merge: z.string().min(1),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

/** The prompt for the planning agent. It gets the file list, so it needs no tools to see the vault. */
export function planPrompt(files: string[]): string {
  return [
    'Propose how to reorganise my vault. Do not use any tools: the complete file list is below.',
    'Reply with exactly one fenced block, and nothing that changes files:',
    '```agenthq-reorg',
    '{"structure":["Folder/Subfolder"],"moves":[{"from":"Exact/Current/path.md","to":"New/path.md","reason":"short reason"}],"merges":[{"keep":"Exact/path.md","merge":"Exact/duplicate.md","reason":"same content"}]}',
    '```',
    'Rules: copy paths exactly from the list. Never propose anything inside Obi-I or the vault configuration folder. Put duplicates only in merges; never delete.',
    '',
    'Files:',
    ...files.slice(0, MAX_MOVES * 2),
  ].join('\n');
}

/** The plan in the agent's last reply, or the reason it cannot be used. */
export function parsePlan(reply: string): { plan: Plan } | { problem: string } {
  const blocks = [...reply.matchAll(BLOCK)];
  const block = blocks.at(-1);
  if (!block) return { problem: 'The reply had no agenthq-reorg block.' };
  let data: unknown;
  try {
    data = JSON.parse(block[1]!);
  } catch {
    return { problem: 'The agenthq-reorg block is not valid JSON.' };
  }
  const parsed = planSchema.safeParse(data);
  if (!parsed.success)
    return {
      problem: `The plan was not valid: ${parsed.error.issues[0]?.message ?? 'check its fields'}.`,
    };
  return { plan: parsed.data };
}

/** The plan as a note the owner reviews. Moves are ticked; merges are suggestions only and are never applied. */
export function planNote(plan: Plan, date: string): string {
  return [
    `# Reorganisation plan ${date}`,
    '',
    'Review this plan. Untick a move (change [x] to [ ]) to skip it, or change the target after →. Then run "Apply reviewed plan". Nothing moves until you apply.',
    '',
    '## Proposed folder structure',
    ...plan.structure.map((folder) => `- \`${folder}\``),
    '',
    '## Moves',
    ...plan.moves.map(
      (move) =>
        `- [x] \`${move.from}\` → \`${move.to}\`${move.reason ? ` — ${move.reason}` : ''}`,
    ),
    '',
    '## Suggested merges (not applied)',
    ...plan.merges.map(
      (merge) =>
        `- \`${merge.merge}\` into \`${merge.keep}\`${merge.reason ? ` — ${merge.reason}` : ''}`,
    ),
    '',
  ].join('\n');
}

const MOVE_LINE = /^- \[([ xX])\] `([^`]+)` → `([^`]+)`(?: — .*)?$/;

/**
 * The ticked moves in a reviewed plan note, read from the Moves section only. A line in that section that does not
 * have the expected shape is reported, not guessed at.
 */
export function reviewedMoves(note: string): {
  moves: Move[];
  problems: string[];
} {
  const moves: Move[] = [];
  const problems: string[] = [];
  let inMoves = false;
  for (const line of note.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      inMoves = line.trim() === '## Moves';
      continue;
    }
    // Every list line in the Moves section is a move; one that does not match is reported, not skipped silently.
    if (!inMoves || !line.startsWith('- ')) continue;
    const match = MOVE_LINE.exec(line);
    if (!match) {
      problems.push(`Line not understood and skipped: ${line}`);
      continue;
    }
    if (match[1] !== ' ')
      moves.push({ from: match[2]!, to: match[3]!, reason: '' });
  }
  return { moves, problems };
}

/** A vault path that stays inside the vault: relative, no parent or current folder parts, no drive or leading slash. */
function plainVaultPath(path: string): boolean {
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\\'))
    return false;
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Checks each move against the vault as it is now. A move is refused (and reported) when its source does not exist,
 * its target is taken, either side is inside Obi-I or the configuration folder, a path is not a plain vault path,
 * or two moves share a target. Nothing is deleted, ever: a move is only a rename.
 */
export function validateMoves(
  moves: Move[],
  files: Set<string>,
  managedRoot: string,
  configDir: string,
): { valid: Move[]; problems: string[] } {
  const valid: Move[] = [];
  const problems: string[] = [];
  const targets = new Set<string>();
  for (const move of moves) {
    const label = `${move.from} → ${move.to}`;
    // Only notes move. Images and other files stay where they are.
    if (!move.from.endsWith('.md') || !move.to.endsWith('.md'))
      problems.push(`Only notes (.md) can be moved: ${label}`);
    else if (!plainVaultPath(move.from) || !plainVaultPath(move.to))
      problems.push(`Not a plain vault path: ${label}`);
    else if (!files.has(move.from))
      problems.push(`Source not found: ${move.from}`);
    else if (!isVaultSearchable(move.from, managedRoot, configDir))
      problems.push(
        `Source is inside Obi-I or the configuration folder: ${move.from}`,
      );
    else if (!isVaultSearchable(move.to, managedRoot, configDir))
      problems.push(
        `Target is inside Obi-I or the configuration folder: ${move.to}`,
      );
    else if (move.from === move.to)
      problems.push(`Source and target are the same: ${move.from}`);
    else if (files.has(move.to))
      problems.push(`Target already exists: ${move.to}`);
    else if (targets.has(move.to))
      problems.push(`Two moves share the target: ${move.to}`);
    else {
      targets.add(move.to);
      valid.push(move);
      continue;
    }
  }
  return { valid, problems };
}

/** Where a plan note is written: Activity, which agents cannot edit, so a reviewed plan cannot change before apply. */
export function planPath(root: string, stamp: string): string {
  return `${root}/Activity/Reorganisation plan ${stamp}.md`;
}

/**
 * Whether Obsidian updates links when a file is renamed (Settings → Files and links → Automatically update internal
 * links). Without it a rename breaks links, so apply and undo refuse until it is on. Anything but true is off.
 */
export function linksSettingProblem(
  value: unknown,
  action: 'apply' | 'undo',
): string | undefined {
  if (value === true) return undefined;
  return `Turn on Settings → Files and links → Automatically update internal links, then ${action} again.`;
}

/** The confirmation text: the first moves as "from → to", then how many more. Skipped lines are counted, not hidden. */
export function confirmSummary(
  moves: Move[],
  skipped: number,
  shown = 20,
): string {
  const lines = moves
    .slice(0, shown)
    .map((move) => `${move.from} → ${move.to}`);
  if (moves.length > shown) lines.push(`and ${moves.length - shown} more`);
  if (skipped > 0) lines.push(`${skipped} line(s) will be skipped`);
  return lines.join('\n');
}

/** Renames a vault file so that links to it are updated. The plugin passes Obsidian's fileManager.renameFile here. */
export interface Renamer {
  rename(from: string, to: string): Promise<void>;
}

/**
 * Applies moves in batches, in order, one rename at a time. It stops when asked, and reports each failure; a failed
 * move is left as it is and is not retried. Returns the moves that were applied, in order, for the undo log.
 */
export async function applyMoves(
  moves: Move[],
  renamer: Renamer,
  control: {
    shouldStop: () => boolean;
    onProgress?: (done: number, total: number) => void;
  },
  batchSize = 20,
): Promise<{ applied: Move[]; failed: string[]; stopped: boolean }> {
  const applied: Move[] = [];
  const failed: string[] = [];
  for (let start = 0; start < moves.length; start += batchSize) {
    for (const move of moves.slice(start, start + batchSize)) {
      if (control.shouldStop()) return { applied, failed, stopped: true };
      try {
        await renamer.rename(move.from, move.to);
        applied.push(move);
      } catch (error) {
        failed.push(
          `${move.from} → ${move.to}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      control.onProgress?.(applied.length + failed.length, moves.length);
    }
  }
  return { applied, failed, stopped: false };
}

/** The undo log for one applied batch. Undo reads its lines back, so the format stays simple. */
export function undoLogNote(applied: Move[], appliedAt: string): string {
  return [
    '---',
    'agenthq: reorganisation',
    `appliedAt: ${appliedAt}`,
    'undone: false',
    '---',
    `# Reorganise ${appliedAt.slice(0, 10)}`,
    '',
    'Every move below was applied with Obsidian’s rename, so links were updated. "Undo last reorganisation" moves each file back.',
    '',
    ...applied.map((move) => `- \`${move.from}\` → \`${move.to}\``),
    '',
  ].join('\n');
}

/** The moves in an undo log, in the order they were applied. */
export function undoLogMoves(body: string): Move[] {
  return [...body.matchAll(/^- `([^`]+)` → `([^`]+)`$/gm)].map((match) => ({
    from: match[1]!,
    to: match[2]!,
    reason: '',
  }));
}

/**
 * Moves every file back, last move first. A file is skipped when it is no longer at its target, or when something
 * new now sits at its original path: undo never overwrites.
 */
export async function undoMoves(
  entries: Move[],
  renamer: Renamer,
  exists: (path: string) => boolean,
): Promise<{ restored: Move[]; skipped: string[] }> {
  const restored: Move[] = [];
  const skipped: string[] = [];
  for (const move of [...entries].reverse()) {
    if (!exists(move.to)) skipped.push(`${move.to} is no longer there`);
    else if (exists(move.from)) skipped.push(`${move.from} is taken again`);
    else {
      try {
        await renamer.rename(move.to, move.from);
        restored.push(move);
      } catch (error) {
        skipped.push(
          `${move.to}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return { restored, skipped };
}
