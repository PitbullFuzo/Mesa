import { AGENTHQ_FOLDERS } from './starter';

/** Root-level Obi-I notes agents must never edit. Runtimes match exact paths, so a new root note goes here. */
export const AGENTHQ_ROOT_NOTES = [
  'Groups.md',
  'Welcome.md',
  'Guide.md',
  // The plugin writes the vault map and the graph map; agents only read them. The old graph canvas is kept protected too.
  'Vault map.md',
  'Graph map.md',
  'Graph overview.canvas',
] as const;

/**
 * Everything agents may not edit, relative to the vault: every Obi-I folder except Work, and the root notes.
 * Work is the only place agents write. Workdir and every runtime read this one list.
 */
export function protectedAgentHqPaths(managedRoot: string): string[] {
  return [
    ...AGENTHQ_FOLDERS.filter((folder) => folder !== 'Work').map(
      (folder) => `${managedRoot}/${folder}`,
    ),
    ...AGENTHQ_ROOT_NOTES.map((note) => `${managedRoot}/${note}`),
  ];
}
