import type { Store } from './store';
import { rankSnippets, wordCount, type Snippet } from './memory';
import type { Agent } from './model';

/** The plugin-written map of the vault. Agents read it first; it is protected like the other root notes. */
export const VAULT_MAP_NAME = 'Vault map.md';
/** The graph map (hubs, clusters, bridges, orphans) sits beside the vault map; defined here to avoid an import cycle. */
export const GRAPH_MAP_NAME = 'Graph map.md';
export const VAULT_MAP_LIMITS = { titlesPerFolder: 8, maxWords: 1500 } as const;
const PLACEHOLDER = '(add a purpose)';

/** One markdown note in the vault, with how many other notes link to it. */
export interface VaultFile {
  path: string;
  mtime: number;
  incomingLinks: number;
}

/** Mesa's own folder and the vault configuration folder are never mapped or searched. */
export function isVaultSearchable(
  path: string,
  managedRoot: string,
  configDir: string,
): boolean {
  const inside = (folder: string) =>
    path === folder || path.startsWith(`${folder}/`);
  return !inside(managedRoot) && !inside(configDir);
}

/**
 * The "don't delete" note at the top of each map, as an Obsidian callout. It says why the map saves tokens, and that
 * Mesa rebuilds a deleted map. The vault map also names the purpose lines the owner may edit.
 */
export function dontDeleteCallout(vaultMap: boolean): string[] {
  const purposeHint = vaultMap
    ? ' You can edit the "Purpose:" lines (vault map).'
    : '';
  return [
    '> [!info] Built by Mesa to save AI tokens',
    `> Agents read this map first instead of searching your whole vault, which keeps AI costs down. It updates itself; please don't delete or move it. If it is deleted, Mesa rebuilds it.${purposeHint}`,
  ];
}

/** The purpose lines the owner wrote in the previous map, keyed by folder. A placeholder is not a purpose. */
export function parsePurposes(previous: string): Map<string, string> {
  const purposes = new Map<string, string>();
  let folder: string | null = null;
  for (const line of previous.split(/\r?\n/)) {
    const heading = /^## Folder: (.+)$/.exec(line);
    if (heading) {
      folder = heading[1]!;
      continue;
    }
    const purpose = /^Purpose: (.*)$/.exec(line);
    if (purpose && folder !== null && purpose[1]!.trim() !== PLACEHOLDER)
      purposes.set(folder, purpose[1]!.trim());
    if (purpose) folder = null;
  }
  return purposes;
}

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(vault root)';

/**
 * How many searchable notes link to each note. Links from Mesa's own notes (the map included) and from the
 * configuration folder are not counted, so the map cannot raise the notes it lists.
 */
export function incomingLinkCounts(
  links: Record<string, Record<string, number>>,
  managedRoot: string,
  configDir: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [source, targets] of Object.entries(links)) {
    if (!isVaultSearchable(source, managedRoot, configDir)) continue;
    for (const [target, count] of Object.entries(targets))
      counts.set(target, (counts.get(target) ?? 0) + count);
  }
  return counts;
}

/**
 * The vault map as Markdown, built with no AI. Each folder shows its note count, its purpose and its most linked
 * (then most recent) note titles. Output depends only on the vault and the purposes, so it is stable across rebuilds.
 */
export function renderVaultMap(
  files: VaultFile[],
  previous: string,
  managedRoot: string,
  configDir: string,
): string {
  const purposes = parsePurposes(previous);
  const byFolder = new Map<string, VaultFile[]>();
  for (const file of files) {
    if (!isVaultSearchable(file.path, managedRoot, configDir)) continue;
    const folder = folderOf(file.path);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
  }
  const header = [
    '# Vault map',
    '',
    ...dontDeleteCallout(true),
    '',
    'Built by Mesa from your vault, with no AI. Agents read it first. Edit the purpose lines; Mesa keeps them when it rebuilds.',
  ].join('\n');
  const blocks: string[] = [];
  let words = wordCount(header);
  const folders = [...byFolder.keys()].sort();
  for (const [index, folder] of folders.entries()) {
    const notes = byFolder.get(folder)!;
    const titles = [...notes]
      .sort(
        (a, b) =>
          b.incomingLinks - a.incomingLinks ||
          b.mtime - a.mtime ||
          a.path.localeCompare(b.path),
      )
      .slice(0, VAULT_MAP_LIMITS.titlesPerFolder)
      // A plain path, not a wikilink: a link would make the map a backlink hub in the graph.
      .map((file) => '- `' + file.path + '`');
    const block = [
      `## Folder: ${folder}`,
      `Purpose: ${purposes.get(folder) ?? PLACEHOLDER}`,
      `Notes: ${notes.length}`,
      'Most linked or recent:',
      ...titles,
    ].join('\n');
    if (words + wordCount(block) > VAULT_MAP_LIMITS.maxWords) {
      blocks.push(
        `… ${folders.length - index} more folders are not listed here.`,
      );
      break;
    }
    words += wordCount(block);
    blocks.push(block);
  }
  return [header, ...blocks].join('\n\n') + '\n';
}

/** Writes the map note, but only when its content changed, so an unchanged vault is not saved again. */
export async function syncVaultMap(
  store: Store,
  root: string,
  files: VaultFile[],
  configDir: string,
): Promise<void> {
  const path = `${root}/${VAULT_MAP_NAME}`;
  const previous = (await store.loadNote(path))?.body ?? '';
  const body = renderVaultMap(files, previous, root, configDir);
  if (body === previous) return;
  const frontmatter = { agenthq: 'vault-map' };
  if (await store.exists(path)) await store.saveNote(path, frontmatter, body);
  else await store.createNote(path, frontmatter, body);
}

/** Splits a note into passages of about maxWords, at paragraph breaks, without its frontmatter. */
export function passagesFor(
  path: string,
  text: string,
  maxWords = 120,
): Snippet[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const chunks: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
    const words = wordCount(paragraph);
    if (words === 0) continue;
    if (used > 0 && used + words > maxWords) {
      chunks.push(current.join('\n\n'));
      current = [];
      used = 0;
    }
    current.push(paragraph.trim());
    used += words;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks.map((chunk, index) => ({
    id: `${path}#${index}`,
    text: chunk,
  }));
}

const pathOf = (id: string) => id.slice(0, id.lastIndexOf('#'));

/**
 * The part of the prompt that lets an agent with vault access find its way: the map instruction, and the vault
 * passages that best match the message, within the word cap. Empty when there is nothing to add.
 */
export function vaultSearchSection(
  message: string,
  passages: Snippet[],
  capWords: number,
  cache: Map<string, { text: string; tokens: string[] }>,
): string {
  const ranked = rankSnippets(message, passages, capWords, cache);
  // Forget the tokens of passages that no longer exist (deleted or changed notes), so the cache stays the size of the vault.
  const live = new Set(passages.map((passage) => passage.id));
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  if (ranked.length === 0) return '';
  return [
    '## Relevant passages from your vault',
    ...ranked.map(
      (snippet) => '- `' + pathOf(snippet.id) + '`: ' + snippet.text,
    ),
  ].join('\n');
}

/** The instruction every agent with vault access gets. */
export function vaultMapInstruction(managedRoot: string): string {
  return `## Your vault\nRead \`${managedRoot}/${VAULT_MAP_NAME}\` and \`${managedRoot}/${GRAPH_MAP_NAME}\` first. Start from the hub or cluster that fits the task, then open only the notes you need; don't list or read the whole vault.`;
}

export function hasVaultAccess(agent: Pick<Agent, 'vaultAccess'>): boolean {
  return agent.vaultAccess === 'read' || agent.vaultAccess === 'write';
}
