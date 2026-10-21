/** Where a team may already live: the new default and the folder used before the rename. */
/** The folders earlier names used for the team, newest first. A vault that has one keeps using it. */
export const LEGACY_TEAM_FOLDERS = ['Obi-I', 'AgentHQ'];
export const TEAM_FOLDER_CANDIDATES = ['Mesa', ...LEGACY_TEAM_FOLDERS];

/** What the plugin can ask about the vault when it decides where the team is. */
export interface TeamFolderCheck {
  exists(path: string): Promise<boolean>;
  /** True when `<folder>/Agents` holds at least one agent note. */
  hasTeam(folder: string): Promise<boolean>;
}

export type TeamFolderDecision =
  /** The configured folder is there: use it. */
  | { action: 'use'; folder: string }
  /** The configured folder is missing and no team exists anywhere: make the starter team. */
  | { action: 'create'; folder: string }
  /** The configured folder is missing but another folder holds a team: ask before using it, create nothing. */
  | { action: 'offer'; folder: string; found: string };

/**
 * Decides before anything is created. A starter team is made only when no team exists in the configured folder or in
 * any candidate folder.
 */
export async function decideTeamFolder(
  configured: string,
  check: TeamFolderCheck,
  candidates: string[] = TEAM_FOLDER_CANDIDATES,
): Promise<TeamFolderDecision> {
  if (await check.exists(configured))
    return { action: 'use', folder: configured };
  for (const found of candidates) {
    if (found === configured) continue;
    if ((await check.exists(found)) && (await check.hasTeam(found)))
      return { action: 'offer', folder: configured, found };
  }
  return { action: 'create', folder: configured };
}

/**
 * Renames the team folder and changes the setting together. The setting changes only after the rename worked, and
 * is saved before this returns; if saving fails the folder is renamed back and the setting restored.
 */
export async function renameTeamFolder(options: {
  settings: { agenthqFolder: string };
  to: string;
  rename: (from: string, to: string) => Promise<void>;
  save: () => Promise<void>;
}): Promise<void> {
  const { settings, to } = options;
  const from = settings.agenthqFolder;
  await options.rename(from, to);
  settings.agenthqFolder = to;
  try {
    await options.save();
  } catch (error) {
    settings.agenthqFolder = from;
    await options.rename(to, from);
    throw error;
  }
}

/**
 * Marks a team-folder rename. From `begin()` until the plugin reloads, vault events for the old and the new folder
 * are ignored, so nothing writes under the old root while the files move. A failed rename calls `cancel()`.
 */
export class TeamFolderGuard {
  private renaming = false;
  get active(): boolean {
    return this.renaming;
  }
  begin(): void {
    this.renaming = true;
  }
  cancel(): void {
    this.renaming = false;
  }
}

/**
 * Whether a removed or moved map file should be rebuilt where it was: not during a rename, not for other files, and
 * never when the configured root no longer exists (it would bring back a folder that was just renamed away).
 */
export async function rebuildMapAfterRemoval(options: {
  path: string;
  root: string;
  mapNames: string[];
  guard: TeamFolderGuard;
  exists: (path: string) => Promise<boolean>;
  rebuild: () => Promise<void>;
}): Promise<boolean> {
  const { path, root, guard } = options;
  if (guard.active) return false;
  if (!options.mapNames.some((name) => path === `${root}/${name}`))
    return false;
  if (!(await options.exists(root))) return false;
  await options.rebuild();
  return true;
}
