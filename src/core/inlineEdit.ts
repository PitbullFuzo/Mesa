/** One piece of a word-level comparison: unchanged, inserted or deleted text. */
export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Past this many words on either side the comparison falls back to "all deleted, all inserted". */
const DIFF_LIMIT = 1500;

const tokens = (text: string) => text.match(/\s+|[^\s]+/g) ?? [];

/**
 * A word-level diff of the original and the replacement (longest common subsequence of words and spaces), with
 * neighbouring parts of the same kind merged.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += text;
    else parts.push({ type, text });
  };
  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) {
    if (before) push('del', before);
    if (after) push('add', after);
    return parts;
  }
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) push('del', a[i++]!);
    else push('add', b[j++]!);
  }
  while (i < a.length) push('del', a[i++]!);
  while (j < b.length) push('add', b[j++]!);
  return parts;
}

/** What the agent is asked: replace the selection, answer with the replacement text only. */
export function inlineEditPrompt(options: {
  instruction: string;
  selection: string;
  before: string;
  after: string;
}): string {
  return [
    'You edit a passage of a note. Follow the instruction and reply with ONLY the replacement text for the passage:',
    'no explanation, no quotation marks around it and no code fences unless the passage itself has them.',
    'Keep the passage in the same language and Markdown style unless the instruction says otherwise.',
    '',
    `Instruction: ${options.instruction}`,
    '',
    options.before
      ? `Text just before the passage (context only, do not repeat it):\n${options.before}\n`
      : '',
    `Passage to replace:\n<<<\n${options.selection}\n>>>`,
    options.after
      ? `\nText just after the passage (context only, do not repeat it):\n${options.after}`
      : '',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

/** The reply as replacement text: a single wrapping code fence or pair of delimiters the agent added is removed. */
export function cleanReplacement(reply: string, selection: string): string {
  let text = reply.replace(/^\s*\n/, '').replace(/\s+$/, '');
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced && !selection.trimStart().startsWith('```')) text = fenced[1]!;
  const delimited = /^<<<\n?([\s\S]*?)\n?>>>$/.exec(text);
  if (delimited) text = delimited[1]!;
  // Keep the selection's own surrounding blank space, so only its words change.
  const lead = /^\s*/.exec(selection)![0];
  const trail = /\s*$/.exec(selection)![0];
  return lead + text.trim() + trail;
}

/** The lines of the paragraph around a line: from the first non-blank line above to the last one below. */
export function paragraphRange(
  lines: string[],
  line: number,
): { from: number; to: number } | null {
  if (line < 0 || line >= lines.length || lines[line]!.trim() === '')
    return null;
  let from = line;
  let to = line;
  while (from > 0 && lines[from - 1]!.trim() !== '') from--;
  while (to < lines.length - 1 && lines[to + 1]!.trim() !== '') to++;
  return { from, to };
}

/** An unchanged stretch, or one phrase that changed: all its deleted words, then all its inserted words. */
export type DiffSegment =
  { type: 'same'; text: string } | { type: 'change'; del: string; add: string };

/**
 * The diff as phrases for reading. A run of changes (with the single spaces between them) becomes one change holding
 * everything deleted and everything inserted; the spaces around the run stay outside it, so the two sides never
 * touch the words next to them.
 */
export function groupChanges(parts: DiffPart[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  const same = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.type === 'same') last.text += text;
    else segments.push({ type: 'same', text });
  };
  const isSpace = (part?: DiffPart) =>
    part?.type === 'same' && part.text.trim() === '';
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.type === 'same') {
      same(part.text);
      i++;
      continue;
    }
    let del = '';
    let add = '';
    while (i < parts.length) {
      const current = parts[i]!;
      if (current.type === 'del') del += current.text;
      else if (current.type === 'add') add += current.text;
      else if (
        isSpace(current) &&
        parts[i + 1] &&
        parts[i + 1]!.type !== 'same'
      ) {
        del += current.text;
        add += current.text;
      } else break;
      i++;
    }
    // The space on either side of the phrase stays outside it, so the two sides never touch their neighbours.
    const edge = del.trim() ? del : add;
    const lead = /^\s*/.exec(edge)![0];
    const trail = /\s*$/.exec(edge)![0];
    const removed = del.trim();
    const inserted = add.trim();
    same(lead);
    if (removed || inserted)
      segments.push({ type: 'change', del: removed, add: inserted });
    same(trail);
  }
  return segments;
}

/** Above this share of changed words the preview shows Before and After instead of an inline diff. */
export const BIG_CHANGE = 0.5;

const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The share of words that changed: changed words on both sides over all words on both sides. */
export function changeShare(parts: DiffPart[]): number {
  let changed = 0;
  let total = 0;
  for (const part of parts) {
    const words = wordsIn(part.text);
    total += part.type === 'same' ? words * 2 : words;
    if (part.type !== 'same') changed += words;
  }
  return total === 0 ? 0 : changed / total;
}

/** True when most of the text changed (a rewrite or a translation). */
export const isBigChange = (parts: DiffPart[]): boolean =>
  changeShare(parts) > BIG_CHANGE;
