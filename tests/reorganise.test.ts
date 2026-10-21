import { describe, expect, it } from 'vitest';
import {
  applyMoves,
  parsePlan,
  planNote,
  planPrompt,
  reviewedMoves,
  undoLogMoves,
  undoLogNote,
  undoMoves,
  validateMoves,
  MAX_MOVES,
  type Move,
  type Renamer,
} from '../src/core/reorganise';

/** A small vault with links, as a map of path to text. */
function sampleVault(): Map<string, string> {
  return new Map([
    ['Notes/alpha.md', 'Alpha links [[beta]] and [[gamma]].'],
    ['Notes/beta.md', 'Beta.'],
    ['Inbox/gamma.md', 'Gamma links [[alpha]].'],
    ['Inbox/delta.md', 'Delta, a copy of beta.'],
    ['Mesa/Agents/CEO.md', 'The CEO links [[alpha]].'],
  ]);
}

/**
 * Stands in for Obsidian's fileManager.renameFile: moves the file, then rewrites [[old name]] links in every note,
 * as Obsidian does when a name changes. Throws the way Obsidian refuses a clash.
 */
function renamerFor(vault: Map<string, string>): Renamer {
  const base = (path: string) =>
    (path.split('/').pop() ?? path).replace(/\.md$/, '');
  return {
    async rename(from, to) {
      if (!vault.has(from)) throw new Error(`No file ${from}`);
      if (vault.has(to)) throw new Error(`Already exists ${to}`);
      const body = vault.get(from)!;
      vault.delete(from);
      vault.set(to, body);
      const oldName = base(from);
      const newName = base(to);
      if (oldName === newName) return;
      for (const [path, text] of vault)
        vault.set(path, text.split(`[[${oldName}]]`).join(`[[${newName}]]`));
    },
  };
}

/** Every [[link]] in the vault names a note that exists. */
function linksResolve(vault: Map<string, string>): boolean {
  const names = new Set(
    [...vault.keys()].map((path) =>
      (path.split('/').pop() ?? '').replace(/\.md$/, ''),
    ),
  );
  for (const text of vault.values())
    for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g))
      if (!names.has(match[1]!)) return false;
  return true;
}

const snapshot = (vault: Map<string, string>) => [...vault.entries()].sort();

const MOVES: Move[] = [
  {
    from: 'Inbox/gamma.md',
    to: 'Notes/Gamma.md',
    reason: 'belongs with notes',
  },
  { from: 'Inbox/delta.md', to: 'Archive/delta.md', reason: 'old copy' },
];

describe('the plan from the agent', () => {
  it('takes the last agenthq-reorg block and rejects a reply without a valid one', () => {
    const reply = [
      'Here is my plan.',
      '```agenthq-reorg',
      '{"structure":["Notes"],"moves":[{"from":"Inbox/gamma.md","to":"Notes/Gamma.md","reason":"r"}],"merges":[]}',
      '```',
    ].join('\n');
    const parsed = parsePlan(reply);
    expect('plan' in parsed && parsed.plan.moves).toEqual([
      { from: 'Inbox/gamma.md', to: 'Notes/Gamma.md', reason: 'r' },
    ]);
    expect(parsePlan('no block here')).toEqual({
      problem: 'The reply had no agenthq-reorg block.',
    });
    expect(parsePlan('```agenthq-reorg\n{not json}\n```')).toEqual({
      problem: 'The agenthq-reorg block is not valid JSON.',
    });
  });

  it('refuses a plan with more moves than the review can hold', () => {
    const moves = Array.from({ length: MAX_MOVES + 1 }, (_, index) => ({
      from: `Inbox/n${index}.md`,
      to: `Notes/n${index}.md`,
    }));
    const reply = '```agenthq-reorg\n' + JSON.stringify({ moves }) + '\n```';
    expect('problem' in parsePlan(reply)).toBe(true);
  });

  it('the prompt carries the file list, and asks for no tools', () => {
    const prompt = planPrompt(['Notes/alpha.md']);
    expect(prompt).toContain('Do not use any tools');
    expect(prompt).toContain('Notes/alpha.md');
  });

  it('the plan note ticks each move and keeps merges as suggestions only', () => {
    const note = planNote(
      {
        structure: ['Notes'],
        moves: MOVES,
        merges: [
          { keep: 'Notes/beta.md', merge: 'Inbox/delta.md', reason: 'same' },
        ],
      },
      '2026-10-20',
    );
    expect(note).toContain('- [x] `Inbox/gamma.md` → `Notes/Gamma.md`');
    expect(note).toContain('## Suggested merges (not applied)');
    expect(note).not.toMatch(/- \[x\] `Inbox\/delta\.md` into/);
  });
});

describe('reviewing the plan', () => {
  it('reads ticked moves, honours a changed target, skips unticked lines, and reports lines it cannot read', () => {
    const edited = [
      '# Reorganisation plan 2026-10-20',
      '## Moves',
      '- [x] `Inbox/gamma.md` → `Notes/Renamed.md` — reason',
      '- [ ] `Inbox/delta.md` → `Archive/delta.md` — unticked, so skipped',
      '- this line is not a move',
      '## Suggested merges (not applied)',
      '- `Inbox/delta.md` into `Notes/beta.md` — suggestion only',
    ].join('\n');
    const { moves, problems } = reviewedMoves(edited);
    expect(moves).toEqual([
      { from: 'Inbox/gamma.md', to: 'Notes/Renamed.md', reason: '' },
    ]);
    expect(problems).toEqual([
      'Line not understood and skipped: - this line is not a move',
    ]);
  });

  it('refuses each unsafe move with a reason, and keeps the good ones', () => {
    const vault = sampleVault();
    const { valid, problems } = validateMoves(
      [
        { from: 'Inbox/missing.md', to: 'Notes/x.md', reason: '' },
        { from: 'Inbox/gamma.md', to: 'Notes/beta.md', reason: '' },
        { from: 'Mesa/Agents/CEO.md', to: 'Notes/CEO.md', reason: '' },
        { from: 'Inbox/gamma.md', to: 'Mesa/Gamma.md', reason: '' },
        { from: 'Inbox/gamma.md', to: '../outside.md', reason: '' },
        { from: 'Inbox/delta.md', to: 'Notes/Same.md', reason: '' },
        { from: 'Inbox/delta.md', to: 'Notes/Same.md', reason: '' },
        { from: 'Notes/alpha.md', to: 'Notes/alpha.md', reason: '' },
        ...MOVES,
      ],
      new Set(vault.keys()),
      'Mesa',
      '.obsidian',
    );
    // Only the first of two moves to the same target survives, and the two good MOVES pass.
    expect(valid.map((move) => move.to)).toEqual([
      'Notes/Same.md',
      'Notes/Gamma.md',
      'Archive/delta.md',
    ]);
    expect(problems.join('\n')).toContain('Source not found: Inbox/missing.md');
    expect(problems.join('\n')).toContain(
      'Target already exists: Notes/beta.md',
    );
    expect(problems.join('\n')).toContain('Source is inside Mesa');
    expect(problems.join('\n')).toContain('Target is inside Mesa');
    expect(problems.join('\n')).toContain('Not a plain vault path');
    expect(problems.join('\n')).toContain(
      'Two moves share the target: Notes/Same.md',
    );
    expect(problems.join('\n')).toContain('Source and target are the same');
  });
});

describe('applying and undoing on a sample vault with links', () => {
  it('applies the moves, keeps every link working, and deletes nothing', async () => {
    const vault = sampleVault();
    const before = vault.size;
    const result = await applyMoves(MOVES, renamerFor(vault), {
      shouldStop: () => false,
    });
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(vault.size).toBe(before);
    expect(vault.has('Notes/Gamma.md')).toBe(true);
    expect(vault.get('Notes/alpha.md')).toContain('[[beta]]');
    expect(vault.get('Mesa/Agents/CEO.md')).toBe('The CEO links [[alpha]].');
    expect(linksResolve(vault)).toBe(true);
  });

  it('a failed move is reported, and the others still apply', async () => {
    const vault = sampleVault();
    const renamer = renamerFor(vault);
    const flaky: Renamer = {
      rename: (from, to) =>
        from === 'Inbox/delta.md'
          ? Promise.reject(new Error('locked'))
          : renamer.rename(from, to),
    };
    const result = await applyMoves(MOVES, flaky, { shouldStop: () => false });
    expect(result.applied.map((move) => move.from)).toEqual(['Inbox/gamma.md']);
    expect(result.failed).toEqual([
      'Inbox/delta.md → Archive/delta.md: locked',
    ]);
    expect(linksResolve(vault)).toBe(true);
  });

  it('stops when asked, and the moves already made can be undone', async () => {
    const vault = sampleVault();
    const original = snapshot(vault);
    let calls = 0;
    const result = await applyMoves(MOVES, renamerFor(vault), {
      shouldStop: () => calls++ >= 1,
    });
    expect(result.stopped).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(linksResolve(vault)).toBe(true);
    const undo = await undoMoves(result.applied, renamerFor(vault), (path) =>
      vault.has(path),
    );
    expect(undo.restored).toHaveLength(1);
    expect(snapshot(vault)).toEqual(original);
  });

  it('undo restores the original layout exactly, from the undo log, and links still work', async () => {
    const vault = sampleVault();
    const original = snapshot(vault);
    const result = await applyMoves(MOVES, renamerFor(vault), {
      shouldStop: () => false,
    });
    const log = undoLogNote(result.applied, '2026-10-20T10:00:00.000Z');
    const entries = undoLogMoves(log);
    expect(entries).toEqual(
      result.applied.map(({ from, to }) => ({ from, to, reason: '' })),
    );
    const undo = await undoMoves(entries, renamerFor(vault), (path) =>
      vault.has(path),
    );
    expect(undo.skipped).toEqual([]);
    expect(snapshot(vault)).toEqual(original);
    expect(linksResolve(vault)).toBe(true);
  });

  it('undo never overwrites: a file now at the original path, or a missing target, is skipped', async () => {
    const vault = sampleVault();
    const result = await applyMoves(MOVES, renamerFor(vault), {
      shouldStop: () => false,
    });
    vault.set('Inbox/gamma.md', 'A new note put back in the old place.');
    vault.delete('Archive/delta.md');
    const undo = await undoMoves(result.applied, renamerFor(vault), (path) =>
      vault.has(path),
    );
    expect(undo.restored).toEqual([]);
    expect(undo.skipped).toEqual([
      'Archive/delta.md is no longer there',
      'Inbox/gamma.md is taken again',
    ]);
    expect(vault.get('Inbox/gamma.md')).toBe(
      'A new note put back in the old place.',
    );
  });
});
