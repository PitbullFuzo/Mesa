import { protectedAgentHqPaths } from './protectedFolders';

/** Obsidian's "Excluded files" list (app setting `userIgnoreFilters`). Search and the graph skip what it lists. */
export const EXCLUDED_FILES_KEY = 'userIgnoreFilters';

/**
 * The outside folders one agent may use. An agent without its own list (every agent made before this version) keeps
 * all the folders Settings allows, so an upgrade changes nothing. A list, even an empty one, is used as written.
 */
export function agentOutsideFolders(
  agent: { outsideFolders?: string[] },
  allowed: string[],
): string[] {
  const ticked = agent.outsideFolders;
  return ticked === undefined
    ? allowed
    : allowed.filter((folder) => ticked.includes(folder));
}

const trimSlashes = (path: string) => path.replace(/\/+$/, '');

/**
 * Why a vault folder cannot be a project's Output folder, or undefined when it can. The folder must be inside the
 * vault and must not be the configuration folder or any protected Obi-I folder. Work is allowed.
 */
export function outputFolderProblem(
  folder: string,
  managedRoot: string,
  configDir: string,
): string | undefined {
  const clean = trimSlashes(folder.trim().replace(/\\/g, '/'));
  if (clean === '') return undefined;
  if (clean.startsWith('/') || /^[a-z]:/i.test(clean))
    return 'Use a folder inside the vault.';
  if (
    clean
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    return 'Use a plain folder name inside the vault.';
  const lower = clean.toLowerCase();
  const config = configDir.toLowerCase();
  if (lower === config || lower.startsWith(`${config}/`))
    return 'The vault configuration folder is protected.';
  for (const entry of protectedAgentHqPaths(managedRoot)) {
    const protectedPath = entry.toLowerCase();
    if (
      lower === protectedPath ||
      lower.startsWith(`${protectedPath}/`) ||
      protectedPath.startsWith(`${lower}/`)
    )
      return `${entry} is protected. Choose another folder for the output.`;
  }
  return undefined;
}

/** The Excluded files list with `folder` added (hide) or removed (show). Other entries keep their order. */
export function excludedFilesWith(
  list: string[],
  folder: string,
  hide: boolean,
): string[] {
  const target = trimSlashes(folder);
  const others = list.filter((entry) => trimSlashes(entry) !== target);
  return hide ? [...others, `${target}/`] : others;
}

/** Whether the Excluded files list hides `folder`. */
export function isExcluded(list: string[], folder: string): boolean {
  const target = trimSlashes(folder);
  return list.some((entry) => trimSlashes(entry) === target);
}

/** The part of Obsidian's vault config the hide toggle needs. */
export interface ExcludedFilesConfig {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

function excludedList(config: ExcludedFilesConfig): string[] {
  const value = config.getConfig(EXCLUDED_FILES_KEY);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Whether Obsidian's Excluded files list already hides the folder. */
export function isFolderHidden(
  config: ExcludedFilesConfig,
  folder: string,
): boolean {
  return isExcluded(excludedList(config), folder);
}

/** Hides or shows a folder in Search and the graph, through Obsidian's Excluded files list. */
export function setFolderHidden(
  config: ExcludedFilesConfig,
  folder: string,
  hide: boolean,
): void {
  config.setConfig(
    EXCLUDED_FILES_KEY,
    excludedFilesWith(excludedList(config), folder, hide),
  );
}

/** Creates a vault folder and any missing parents. Existing folders are left alone. */
export async function ensureFolder(
  store: {
    exists(path: string): Promise<boolean>;
    createFolder(path: string): Promise<void>;
  },
  folder: string,
): Promise<void> {
  let current = '';
  for (const part of folder.split('/')) {
    current = current ? `${current}/${part}` : part;
    if (!(await store.exists(current))) await store.createFolder(current);
  }
}
