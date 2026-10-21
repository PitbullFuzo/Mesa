import { z } from 'zod';
import type { NoteDocument } from './notes';
import type { Store } from './store';
import {
  projectSlug,
  type ContextLevel,
  type MemoryChoice,
  type Project,
} from './projects';
import type { RuntimeAdapter, RuntimeId } from './runtimes/types';

/** Memory model order for "auto": the cheapest runtime first, then any other available one. */
const AUTO_ORDER: { runtime: RuntimeId; model: string }[] = [
  { runtime: 'claude-code', model: 'haiku' },
  { runtime: 'opencode', model: '' },
  { runtime: 'codex', model: '' },
  { runtime: 'hermes', model: '' },
];

export const LOG_TAIL_ENTRIES = 15;
export const RETRIEVAL_CAP_WORDS = 1500;

export interface ResolvedMemoryModel {
  adapter: RuntimeAdapter;
  model: string;
}

/** Picks the runtime that does memory work, or null for "off" or when nothing is available. */
export function resolveMemoryRuntime(
  choice: MemoryChoice,
  adapters: RuntimeAdapter[],
  available: (id: RuntimeId) => boolean,
): ResolvedMemoryModel | null {
  if (choice === 'off') return null;
  if (choice !== 'auto') {
    const adapter = adapters.find((entry) => entry.id === choice);
    if (!adapter || !available(adapter.id)) return null;
    return { adapter, model: choice === 'claude-code' ? 'haiku' : '' };
  }
  for (const entry of AUTO_ORDER) {
    const adapter = adapters.find(
      (candidate) => candidate.id === entry.runtime,
    );
    if (adapter && available(adapter.id))
      return { adapter, model: entry.model };
  }
  const other = adapters.find((adapter) => available(adapter.id));
  return other ? { adapter: other, model: '' } : null;
}

export function memoryFolder(root: string, project: Project): string {
  return `${root}/Projects/${project.name}`;
}
export function memoryNotesFolder(root: string, project: Project): string {
  return `${memoryFolder(root, project)}/Memory`;
}
export function logNotePath(root: string, project: Project): string {
  return `${memoryFolder(root, project)}/Log.md`;
}

/** One Log entry for a finished task. No model is involved. */
export function taskLogEntry(input: {
  time: string;
  link: string;
  agent: string;
  status: string;
  verdict?: string;
}): string {
  const verdict = input.verdict ? ` · verdict: ${input.verdict}` : '';
  return `- ${input.time} · ${input.link} · ${input.agent} · ${input.status}${verdict}`;
}

const memoryItem = z.object({
  type: z.enum(['decision', 'fact', 'preference', 'question']),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  mergeInto: z.string().trim().min(1).max(120).optional(),
});
export type MemoryItem = z.infer<typeof memoryItem>;
const memoryBlock = z.object({ memories: z.array(memoryItem).max(20) });

/** Reads every agenthq-memory block in a reply. Invalid blocks are reported, never saved. */
export function parseMemoryBlocks(text: string): {
  items: MemoryItem[];
  problems: string[];
} {
  const items: MemoryItem[] = [];
  const problems: string[] = [];
  for (const match of text.matchAll(/```agenthq-memory\s*\n([\s\S]*?)```/g)) {
    let json: unknown;
    try {
      json = JSON.parse(match[1] ?? '');
    } catch {
      problems.push('A memory block was not valid JSON, so it was not saved.');
      continue;
    }
    const parsed = memoryBlock.safeParse(json);
    if (!parsed.success) {
      problems.push(
        `A memory block was refused: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`,
      );
      continue;
    }
    items.push(...parsed.data.memories);
  }
  return { items, problems };
}

async function ensureFolders(store: Store, path: string): Promise<void> {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const folder = parts.slice(0, index).join('/');
    if (!(await store.exists(folder))) await store.createFolder(folder);
  }
}

/**
 * Saves memory items. Decisions go to the Log; other items become Memory notes, merged into an
 * existing note with the same title (or the one named in mergeInto) rather than duplicated.
 * Returns the Log lines to append; the caller appends them in one write.
 */
export async function saveMemoryItems(
  store: Store,
  root: string,
  project: Project,
  items: MemoryItem[],
  source: string,
  now: string,
): Promise<{ logLines: string[]; saved: number; merged: number }> {
  const logLines: string[] = [];
  let saved = 0;
  let merged = 0;
  const folder = memoryNotesFolder(root, project);
  for (const item of items) {
    if (item.type === 'decision') {
      logLines.push(
        `- ${now} · decision: ${item.title} — ${item.body} · ${source}`,
      );
      continue;
    }
    const existing = await store.loadNotesUnder(folder);
    const wanted = (item.mergeInto ?? item.title).toLowerCase();
    const target = existing.find(
      (note) =>
        note.name.toLowerCase() === wanted ||
        note.name.toLowerCase() === projectSlug(wanted).toLowerCase(),
    );
    if (target) {
      const frontmatter = (target.frontmatter ?? {}) as Record<string, unknown>;
      const tags = [
        ...new Set([
          ...(Array.isArray(frontmatter.tags)
            ? (frontmatter.tags as string[])
            : []),
          ...item.tags,
        ]),
      ];
      await store.saveNote(
        target.path,
        { ...frontmatter, tags, updated: now },
        `${target.body.trimEnd()}\n\n## ${now.slice(0, 10)}\n${item.body}\n`,
      );
      merged++;
      logLines.push(`- ${now} · memory merged: ${target.name} · ${source}`);
      continue;
    }
    await ensureFolders(store, folder);
    let path = `${folder}/${projectSlug(item.title)}.md`;
    for (let suffix = 2; await store.exists(path); suffix++)
      path = `${folder}/${projectSlug(item.title)} (${suffix}).md`;
    await store.createNote(
      path,
      {
        agenthq: 'memory',
        type: item.type,
        tags: item.tags,
        source,
        updated: now,
      },
      `# ${item.title}\n\n${item.body}\n`,
    );
    saved++;
    logLines.push(`- ${now} · memory saved: ${item.title} · ${source}`);
  }
  return { logLines, saved, merged };
}

/** Appends lines to the project Log, creating the Log on first use. */
export async function appendLogLines(
  store: Store,
  root: string,
  project: Project,
  lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const path = logNotePath(root, project);
  const log = await store.loadNote(path);
  if (!log) {
    await ensureFolders(store, memoryFolder(root, project));
    await store.createNote(
      path,
      { agenthq: 'log', project: project.name },
      `# Log\n\n${lines.join('\n')}\n`,
    );
    return;
  }
  await store.saveNote(
    path,
    log.frontmatter as Record<string, unknown>,
    `${log.body.trimEnd()}\n${lines.join('\n')}\n`,
  );
}

/** Log entries (one bullet each) from a Log note. */
export function logEntries(log: NoteDocument | null): string[] {
  return (log?.body ?? '').split('\n').filter((line) => line.startsWith('- '));
}

/** Money spent on memory work, as recorded in Log lines. */
export function memoryCostFromLog(entries: string[]): number {
  let total = 0;
  for (const entry of entries)
    for (const match of entry.matchAll(/memory cost \$([0-9.]+)/g))
      total += Number(match[1]);
  return total;
}

export const MEMORY_INSTRUCTION =
  'Project memory: when a decision, or a durable fact, preference or open question about this project is settled, end your reply with one block, and only then:\n' +
  '```agenthq-memory\n{"memories":[{"type":"decision","title":"short title","body":"one or two sentences"}]}\n```\n' +
  'Types: decision, fact, preference, question. Use it rarely; never for routine progress.';

export interface Snippet {
  id: string;
  text: string;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** Keeps the first words of a text, up to the cap. */
export function truncateWords(text: string, cap: number): string {
  const words = text.split(/\s+/).filter((word) => word !== '');
  return words.length <= cap ? text : words.slice(0, cap).join(' ') + ' …';
}

const TOKEN = /[\p{L}\p{N}]+/gu;
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN) ?? []).filter(
    (token) => token.length > 1,
  );
}

/**
 * Keyword ranking (BM25) over memory snippets. Returns the best-matching snippets, in rank order,
 * whose words fit under the cap. Token lists are cached per snippet id and reused while the text is unchanged.
 */
export function rankSnippets(
  query: string,
  docs: Snippet[],
  capWords: number,
  cache = new Map<string, { text: string; tokens: string[] }>(),
): Snippet[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const tokenized = docs.map((doc) => {
    const cached = cache.get(doc.id);
    if (cached?.text === doc.text) return { doc, tokens: cached.tokens };
    const tokens = tokenize(doc.text);
    cache.set(doc.id, { text: doc.text, tokens });
    return { doc, tokens };
  });
  const k1 = 1.2;
  const b = 0.75;
  const average =
    tokenized.reduce((sum, entry) => sum + entry.tokens.length, 0) /
      tokenized.length || 1;
  const count = tokenized.length;
  const scored = tokenized
    .map((entry) => {
      let score = 0;
      for (const term of terms) {
        const tf = entry.tokens.filter((token) => token === term).length;
        if (tf === 0) continue;
        const df = tokenized.filter((other) =>
          other.tokens.includes(term),
        ).length;
        const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
        score +=
          (idf * tf * (k1 + 1)) /
          (tf + k1 * (1 - b + (b * entry.tokens.length) / average));
      }
      return { doc: entry.doc, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: Snippet[] = [];
  let used = 0;
  for (const { doc } of scored) {
    const words = wordCount(doc.text);
    if (used + words > capWords) continue;
    picked.push(doc);
    used += words;
  }
  return picked;
}

/** The prompt for one memory extraction run. It asks for memory blocks only. */
export function extractionPrompt(input: {
  project: Project;
  existing: NoteDocument[];
  results: { title: string; text: string }[];
}): string {
  const existing = input.existing
    .map((note) => `- ${note.name}: ${note.body.split('\n')[0] ?? ''}`)
    .join('\n');
  const results = input.results
    .map((result) => `### ${result.title}\n${result.text}`)
    .join('\n\n');
  return [
    `Memory extraction for project "${input.project.name}". Do not use tools; reply with text only.`,
    'From the finished task results below, extract only durable, atomic memories: one fact, decision, preference or open question per item. Skip routine progress.',
    'If a memory updates an existing one, set "mergeInto" to that memory\'s exact name instead of repeating it.',
    'Reply with exactly one agenthq-memory block and nothing else, in this shape:',
    '```agenthq-memory\n{"memories":[{"type":"fact","title":"short title","body":"one or two sentences","tags":["tag"]}]}\n```',
    '',
    'Existing memories:',
    existing || '(none)',
    '',
    'Finished task results:',
    truncateWords(results, 1500),
  ].join('\n');
}

export const MEMORY_CHOICE_LABELS: Record<MemoryChoice, string> = {
  auto: 'Auto (cheapest installed runtime)',
  off: 'Off (log only, no model calls)',
  'claude-code': 'Claude Code (haiku)',
  opencode: 'OpenCode',
  codex: 'Codex',
  hermes: 'Hermes',
};

export const CONTEXT_LEVEL_LABELS: Record<ContextLevel, string> = {
  brief: 'Brief only',
  'brief+memory': 'Brief + memory (default)',
  full: 'Full (+ recent log)',
};
