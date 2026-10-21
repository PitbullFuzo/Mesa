/** Longest label drawn in the vault overview; longer titles are cut with "…". */
export const LABEL_LIMIT = 32;

const STAMP =
  /^\d{4}-\d{2}-\d{2}(?:[ T_-]+\d{2}[:.]?\d{2}(?:[:.]?\d{2})?)?(?=$|[\s_.-])[\s_.-]*/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A long id or hash: a UUID, a long hex run, or a long mixed run of letters and digits. */
function looksLikeId(word: string): boolean {
  if (UUID.test(word)) return true;
  if (/^[0-9a-f]{8,}$/i.test(word)) return true;
  return word.length >= 12 && /\d/.test(word) && /[a-z]/i.test(word);
}

const cut = (text: string) =>
  text.length > LABEL_LIMIT
    ? `${text.slice(0, LABEL_LIMIT - 1).trimEnd()}…`
    : text;

/** The file name of a path without its folder and ".md". */
export const fileTitle = (path: string) =>
  (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * A short name for a note: no folder, no ".md", no leading date or time stamp, no long ids or hashes, and cut to
 * LABEL_LIMIT characters. Falls back to the plain file name when cleaning would leave nothing.
 */
export function shortTitle(path: string): string {
  const plain = fileTitle(path);
  const words = plain
    .replace(STAMP, '')
    .split(/\s+/)
    .filter((word) => word !== '' && !looksLikeId(word));
  const cleaned = words.join(' ').replace(/^[\s_.-]+|[\s_.-]+$/g, '');
  return cut(cleaned || plain);
}

/**
 * A cluster's name: the folder when most of its notes share one, else its hub's short title. Notes in the vault's
 * root have no folder name to share.
 */
export function clusterName(hub: string, members: string[]): string {
  const folders = new Map<string, number>();
  for (const path of members) {
    const parts = path.split('/');
    if (parts.length < 2) continue;
    const folder = parts[parts.length - 2]!;
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  const [folder, count] = [...folders].sort((a, b) => b[1] - a[1])[0] ?? [
    '',
    0,
  ];
  return folder && count > members.length / 2 && members.length > 1
    ? cut(folder)
    : shortTitle(hub);
}
