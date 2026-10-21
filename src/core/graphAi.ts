import { z } from 'zod';
import { truncateWords } from './memory';
import type { Store } from './store';
import type { GraphAnalysis } from './graphMap';

/** Optional AI concepts pass limits. Off by default; each note is read once per change. */
export const GRAPH_AI_LIMITS = {
  notesPerRun: 10,
  concepts: 5,
  related: 5,
  /** Note words sent to the model; verification uses the same text, so a phrase must be in what the model saw. */
  noteWords: 1500,
  /** Paths listed in the prompt so the model can name real notes. */
  promptPaths: 200,
} as const;

/** A note with at most this many links is a candidate: the pass is for notes with few or no links. */
const LOW_LINK_DEGREE = 1;

export const GRAPH_AI_PRIVACY =
  "Free models' providers may keep or train on what they read. Don't use them on private notes.";

const replySchema = z.object({
  concepts: z
    .array(z.string().trim().min(1).max(80))
    .max(GRAPH_AI_LIMITS.concepts)
    .default([]),
  related: z
    .array(
      z.object({
        path: z.string().trim().min(1).max(300),
        phrase: z.string().trim().min(1).max(120),
      }),
    )
    .max(GRAPH_AI_LIMITS.related)
    .default([]),
});

export type GraphAiReply = z.infer<typeof replySchema>;

export interface VerifiedConcepts {
  concepts: string[];
  related: { path: string; phrase: string }[];
  /** Proposals dropped because they named no real note or no phrase from the note. */
  dropped: number;
}

/** Whitespace and case do not count when checking a phrase against a note. */
export const normalisePhrase = (text: string) =>
  text.toLowerCase().replace(/\s+/g, ' ').trim();

/** The prompt for one note. The model must answer with JSON only, using real paths and exact phrases. */
export function graphAiPrompt(
  note: { path: string; text: string },
  notePaths: string[],
): string {
  return [
    'You map one note of a personal vault. Reply with JSON only, no other text, in this shape:',
    '{"concepts": ["short phrase"], "related": [{"path": "exact path from the list", "phrase": "exact words from this note"}]}',
    `At most ${GRAPH_AI_LIMITS.concepts} concepts and ${GRAPH_AI_LIMITS.related} related notes. Every concept and every phrase must appear word for word in the note below. Related paths must come from the list below, and never be this note's own path. If you are not sure, leave the entry out.`,
    '',
    `This note's path: ${note.path}`,
    '',
    'Note paths you may relate to:',
    ...notePaths
      .slice(0, GRAPH_AI_LIMITS.promptPaths)
      .map((path) => `- ${path}`),
    '',
    'The note:',
    '"""',
    note.text,
    '"""',
  ].join('\n');
}

/** Reads the first JSON object in a reply. Anything that does not match the shape is null, and the note is retried later. */
export function parseGraphAiReply(text: string): GraphAiReply | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = replySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Keeps only what the plugin can check: a concept must appear in the note, and a related note must be a real note
 * (not this one) whose phrase appears in this note. Everything else is dropped and counted.
 */
export function verifyGraphAiReply(
  note: { path: string; text: string },
  reply: GraphAiReply,
  notePaths: Set<string>,
): VerifiedConcepts {
  const body = normalisePhrase(note.text);
  let dropped = 0;
  const concepts: string[] = [];
  for (const concept of reply.concepts) {
    const shown = plainText(concept);
    if (shown && body.includes(normalisePhrase(concept))) concepts.push(shown);
    else dropped += 1;
  }
  const related: { path: string; phrase: string }[] = [];
  for (const link of reply.related) {
    const real = notePaths.has(link.path) && link.path !== note.path;
    const shown = plainText(link.phrase);
    if (real && shown && body.includes(normalisePhrase(link.phrase)))
      related.push({ path: link.path, phrase: shown });
    else dropped += 1;
  }
  return { concepts, related, dropped };
}

/**
 * Model text as it goes into the map: no link brackets and no backticks, so a phrase cannot create a wikilink (a new
 * edge in the graph) or break a code span.
 */
const plainText = (text: string) => text.replace(/[[\]`]/g, '').trim();

export interface GraphAiResult extends VerifiedConcepts {
  mtime: number;
}

/**
 * The notes to read this pass: few links, not yet read at their current modified time, in path order, at most
 * notesPerRun. A note that was already read is skipped until it changes.
 */
export function graphAiCandidates(
  analysis: GraphAnalysis,
  mtimes: Map<string, number>,
  done: Map<string, GraphAiResult>,
): { path: string; mtime: number }[] {
  return analysis.graph.notes
    .filter(
      (note) =>
        (analysis.graph.neighbours.get(note.path)?.size ?? 0) <=
          LOW_LINK_DEGREE &&
        done.get(note.path)?.mtime !== mtimes.get(note.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, GRAPH_AI_LIMITS.notesPerRun)
    .map((note) => ({ path: note.path, mtime: note.mtime }));
}

export interface GraphAiPassDeps {
  /** The note's text as the pass should read it (frontmatter removed), or null when it cannot be read. */
  readNote(path: string): Promise<string | null>;
  /**
   * One model call. Null when no runtime is available; `refused` when the runtime may not run the pass (with the
   * reason to show in Settings); isError when the call failed.
   */
  ask(prompt: string): Promise<GraphAiReplyOrRefusal | null>;
  signal: AbortSignal;
}

export interface GraphAiPassResult {
  checked: number;
  failed: number;
  dropped: number;
  costUsd: number;
  /** "no runtime" when the pass could not start; empty otherwise. */
  skipped: string;
}

/**
 * Runs the pass over the candidates and stores each verified result in `done`. A note is recorded at its modified
 * time even when the reply is bad, so one bad reply does not repeat every rebuild; a changed note is read again.
 */
export async function runGraphAiPass(
  candidates: { path: string; mtime: number }[],
  notePaths: Set<string>,
  done: Map<string, GraphAiResult>,
  deps: GraphAiPassDeps,
): Promise<GraphAiPassResult> {
  const result: GraphAiPassResult = {
    checked: 0,
    failed: 0,
    dropped: 0,
    costUsd: 0,
    skipped: '',
  };
  for (const candidate of candidates) {
    if (deps.signal.aborted) break;
    const raw = await deps.readNote(candidate.path);
    if (raw === null) continue;
    const text = truncateWords(raw, GRAPH_AI_LIMITS.noteWords);
    const reply = await deps.ask(
      graphAiPrompt({ path: candidate.path, text }, [...notePaths]),
    );
    if (reply === null) {
      result.skipped = 'no runtime';
      break;
    }
    if (reply.refused) {
      result.skipped = reply.refused;
      break;
    }
    result.costUsd += reply.costUsd;
    result.checked += 1;
    const parsed = reply.isError ? null : parseGraphAiReply(reply.text);
    if (!parsed) {
      result.failed += 1;
      done.set(candidate.path, {
        mtime: candidate.mtime,
        concepts: [],
        related: [],
        dropped: 0,
      });
      continue;
    }
    const verified = verifyGraphAiReply(
      { path: candidate.path, text },
      parsed,
      notePaths,
    );
    result.dropped += verified.dropped;
    done.set(candidate.path, { mtime: candidate.mtime, ...verified });
  }
  return result;
}

/** The section of the graph map that shows AI results, with the cost and what was dropped. Empty when none. */
export function graphAiSection(
  done: Map<string, GraphAiResult>,
  session: { costUsd: number; dropped: number; checked: number },
  live: Set<string>,
): string[] {
  const entries = [...done.entries()]
    .filter(([path]) => live.has(path))
    .filter(
      ([, result]) => result.concepts.length > 0 || result.related.length > 0,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    '## AI concepts (optional, off by default)',
    `Read by a model: ${session.checked} notes this session, $${session.costUsd.toFixed(4)} spent, ${session.dropped} unverifiable suggestions dropped. ${GRAPH_AI_PRIVACY}`,
  ];
  if (entries.length === 0) {
    lines.push('(no concepts kept yet)');
    return lines;
  }
  for (const [path, result] of entries) {
    if (result.concepts.length > 0)
      lines.push(`- \`${path}\`: ${result.concepts.join(', ')}`);
    for (const link of result.related)
      lines.push(`- \`${path}\` relates to \`${link.path}\`: "${link.phrase}"`);
  }
  return lines;
}

/** The note's text without its frontmatter, as the pass reads it. */
export const stripFrontmatter = (text: string) =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/** A model call's answer, or why the pass may not run with that runtime. */
export type GraphAiReplyOrRefusal = {
  text: string;
  costUsd: number;
  isError: boolean;
  refused?: string;
};

/**
 * Codex can read the whole computer, so the AI pass does not run with it at all. The reason is shown in Settings.
 * Null when the runtime may run the pass.
 */
export function graphAiRefusal(runtime: string): string | null {
  return runtime === 'codex'
    ? 'Codex can read the whole computer, so the AI concepts pass does not run with it. Choose Claude Code or OpenCode as the Project memory model.'
    : null;
}

/** The kept results, in the protected Activity folder, so a restart does not read every note again. */
export const GRAPH_CONCEPTS_NAME = 'Graph concepts.json';
export const graphConceptsPath = (root: string) =>
  `${root}/Activity/${GRAPH_CONCEPTS_NAME}`;

export interface GraphConceptsFile {
  /** Every dollar the pass has spent, across restarts. */
  totalCostUsd: number;
  results: Map<string, GraphAiResult>;
}

const storedSchema = z.object({
  totalCostUsd: z.number().nonnegative().catch(0),
  results: z
    .record(
      z.string(),
      z.object({
        mtime: z.number(),
        concepts: z.array(z.string()).default([]),
        related: z
          .array(z.object({ path: z.string(), phrase: z.string() }))
          .default([]),
        dropped: z.number().default(0),
      }),
    )
    .catch({}),
});

const emptyConcepts = (): GraphConceptsFile => ({
  totalCostUsd: 0,
  results: new Map(),
});

/** Reads the kept results. Missing or unreadable text gives an empty file, so the pass just starts again. */
export function parseGraphConcepts(text: string | null): GraphConceptsFile {
  if (!text) return emptyConcepts();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyConcepts();
  }
  const parsed = storedSchema.safeParse(raw);
  if (!parsed.success) return emptyConcepts();
  return {
    totalCostUsd: parsed.data.totalCostUsd,
    results: new Map(Object.entries(parsed.data.results)),
  };
}

/** Stable text: sorted by path, so the same results always give the same file. */
export function serialiseGraphConcepts(file: GraphConceptsFile): string {
  const results = Object.fromEntries(
    [...file.results].sort(([a], [b]) => a.localeCompare(b)),
  );
  return (
    JSON.stringify({ totalCostUsd: file.totalCostUsd, results }, null, 2) + '\n'
  );
}

export async function loadGraphConcepts(
  store: Store,
  root: string,
): Promise<GraphConceptsFile> {
  return parseGraphConcepts(await store.readText(graphConceptsPath(root)));
}

/** Writes the kept results only when their text changed. */
export async function saveGraphConcepts(
  store: Store,
  root: string,
  file: GraphConceptsFile,
): Promise<void> {
  const folder = `${root}/Activity`;
  if (!(await store.exists(folder))) await store.createFolder(folder);
  const path = graphConceptsPath(root);
  const text = serialiseGraphConcepts(file);
  if ((await store.readText(path)) === text) return;
  await store.writeText(path, text);
}

/** One Activity line per pass run: notes read, cost, the running total, and why it stopped early when it did. */
export function graphActivityLine(
  result: GraphAiPassResult,
  totalCostUsd: number,
): string {
  const why = result.skipped ? `, stopped: ${result.skipped}` : '';
  return `Graph map AI concepts: ${result.checked} notes read, $${result.costUsd.toFixed(4)} this rebuild, $${totalCostUsd.toFixed(4)} in total${why}`;
}
