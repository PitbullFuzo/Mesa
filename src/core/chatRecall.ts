import { passagesFor } from './vaultMap';
import { rankSnippets, tokenize, type Snippet } from './memory';
import type { NoteDocument } from './notes';

/** Words from the agent's earlier chats that one message may bring back. */
export const RECALL_CAP_WORDS = 600;

/** Phrases that mean "look back at an earlier conversation", English and Portuguese. The one place to extend. */
export const RECALL_TRIGGERS: RegExp[] = [
  /\blast time\b/i,
  /\bprevious (chat|conversation|session|time)s?\b/i,
  /\b(earlier|previous|past|old) (chat|conversation)s?\b/i,
  /\bwe (discussed|talked|decided|agreed|spoke)\b/i,
  /\b(you|i) (said|told|mentioned|suggested)\b/i,
  /\bremember (when|what|that|we)\b/i,
  /\bearlier\b/i,
  /\bbefore,? (we|you)\b/i,
  /\b(da )?(última|ultima) vez\b/i,
  /\b(conversa|chat) (anterior|passada)\b/i,
  /\b(conversas|chats) (anteriores|passadas)\b/i,
  /\b(falámos|falamos|discutimos|decidimos|combinámos|combinamos|acordámos)\b/i,
  /\b(tu|você|voce|vc) (disseste|disse|falaste|falou|sugeriste|sugeriu|mencionaste|mencionou)\b/i,
  /\b(lembras|lembra|lembras-te|lembra-se)\b/i,
  /\banteriormente\b/i,
];

/** Filler words left out of the search, so only the topic matches (the trigger words themselves too). */
const FILLER = new Set(
  (
    'the and for with that this what when where which who how did does was were are you your we our us about last time ' +
    'before earlier previous chat chats conversation conversations said told talked discussed decided agreed remember ' +
    'mentioned suggested spoke have has had not but can could would should from into then than there their they them ' +
    'que qual quais como quando onde uma uns umas dos das nos nas com por para sobre vez ultima última anterior disse ' +
    'disseste falámos falamos discutimos decidimos lembras lembra voce você tu foi era são sao tem tinha mais'
  ).split(' '),
);

export function isRecallRequest(message: string): boolean {
  return RECALL_TRIGGERS.some((trigger) => trigger.test(message));
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

/** Passages of one agent's chats, other than the current one, each tagged with the chat's title and date. */
export function chatPassages(
  chats: NoteDocument[],
  agentId: string,
  currentPath: string | undefined,
): Snippet[] {
  const out: Snippet[] = [];
  for (const note of chats) {
    const fm = record(note.frontmatter);
    if (fm.agenthq !== 'chat' || fm.agentId !== agentId) continue;
    if (note.path === currentPath) continue;
    for (const passage of passagesFor(note.path, note.body)) out.push(passage);
  }
  return out;
}

/**
 * The "From your earlier conversations" part of the prompt: only when the message looks back, only this agent's own
 * other chats, best BM25 matches within the word cap. Empty when nothing matches.
 */
export function chatRecallSection(
  message: string,
  chats: NoteDocument[],
  agentId: string,
  currentPath: string | undefined,
  cache: Map<string, { text: string; tokens: string[] }>,
  capWords = RECALL_CAP_WORDS,
): string {
  if (!isRecallRequest(message)) return '';
  const passages = chatPassages(chats, agentId, currentPath);
  const topic = tokenize(message)
    .filter((word) => !FILLER.has(word))
    .join(' ');
  const ranked = rankSnippets(topic, passages, capWords, cache);
  const live = new Set(passages.map((passage) => passage.id));
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  if (ranked.length === 0) return '';
  const byPath = new Map(chats.map((note) => [note.path, note]));
  return [
    '## From your earlier conversations',
    ...ranked.map((snippet) => {
      const note = byPath.get(snippet.id.slice(0, snippet.id.lastIndexOf('#')));
      const fm = record(note?.frontmatter);
      const title =
        typeof fm.title === 'string' ? fm.title : (note?.name ?? '');
      const date =
        typeof fm.started === 'string' ? fm.started.slice(0, 10) : '';
      return `- "${title}"${date ? ` (${date})` : ''}: ${snippet.text}`;
    }),
  ].join('\n');
}
