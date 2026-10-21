/** Something the owner can attach to a message with @: a note, a folder (its note list) or another agent's chat. */
export interface MentionCandidate {
  kind: 'note' | 'folder' | 'chat';
  /** What the list shows. */
  label: string;
  path: string;
}

/** The most paths a folder mention lists, and the most messages a chat mention carries. */
export const FOLDER_LIST_CAP = 200;
export const CHAT_MESSAGE_CAP = 6;

/**
 * The "@something" being typed at the caret: its start in the text and the words after the @. Null when the caret is
 * not in such a word (an @ in the middle of a word, like an email address, does not count).
 */
export function mentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** The text with the @word taken out (the chosen item becomes a chip instead). */
export function withoutMention(
  text: string,
  start: number,
  caret: number,
): string {
  return text.slice(0, start) + text.slice(caret).replace(/^ /, '');
}

/** A fuzzy score: higher is better, 0 when the letters of the query do not appear in order. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 1;
  const exact = t.indexOf(q);
  if (exact >= 0) return 1000 - exact - (t.length - q.length) * 0.1;
  let at = -1;
  let gaps = 0;
  for (const letter of q) {
    const found = t.indexOf(letter, at + 1);
    if (found < 0) return 0;
    if (at >= 0) gaps += found - at - 1;
    at = found;
  }
  return Math.max(1, 100 - gaps - (t.length - q.length) * 0.1);
}

/** The best matches, best first (ties by label), at most `limit`. */
export function rankMentions(
  query: string,
  candidates: MentionCandidate[],
  limit = 8,
): MentionCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: Math.max(
        fuzzyScore(query, candidate.label),
        fuzzyScore(query, candidate.path) * 0.8,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.candidate.label.localeCompare(b.candidate.label),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** What a folder mention attaches: the paths of its notes, capped. */
export function folderListing(
  folder: string,
  paths: string[],
): { content: string; truncated: boolean } {
  const shown = paths.slice(0, FOLDER_LIST_CAP);
  return {
    content: `Notes in ${folder} (${paths.length}):\n${shown.map((path) => `- ${path}`).join('\n')}`,
    truncated: paths.length > shown.length,
  };
}

/** What a chat mention attaches: its title and its last few messages. */
export function chatExcerpt(
  title: string,
  messages: { role: string; content: string }[],
  characters = 6000,
): { content: string; truncated: boolean } {
  const lines = messages
    .slice(-CHAT_MESSAGE_CAP)
    .map((message) => `${message.role}: ${message.content.trim()}`);
  const text = `Chat "${title}", last messages:\n${lines.join('\n\n')}`;
  return text.length > characters
    ? { content: text.slice(0, characters), truncated: true }
    : { content: text, truncated: false };
}
