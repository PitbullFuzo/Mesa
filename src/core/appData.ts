import { cp, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The plugin's id, which is also its folder in `.obsidian/plugins/` in a vault. Permanent once published. */
export const PLUGIN_ID = 'mesa';
/** What the plugin was called while it was tested, newest first: its plugin folder in a vault. */
export const LEGACY_PLUGIN_IDS = ['obi-i', 'agenthq'];
/** The folders next to the user's app data that earlier names used, newest first. */
const LEGACY_APP_DATA = ['Obi-I', 'AgentHQ'];
const APP_DATA = 'Mesa';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Carries the newest earlier app-data folder over once, so nothing has to be set up again: the Microsoft sign-in is
 * copied (the old folder is left as it was), and the browser tools, which can be large, are moved. Never overwrites
 * what the new folder already has, and deletes nothing. Returns what was carried.
 */
export async function migrateAppData(
  base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
): Promise<string[]> {
  const next = join(base, APP_DATA);
  const carried: string[] = [];
  for (const name of LEGACY_APP_DATA) {
    const old = join(base, name);
    if (!(await exists(old))) continue;
    if (
      (await exists(join(old, 'connectors'))) &&
      !(await exists(join(next, 'connectors')))
    ) {
      await mkdir(next, { recursive: true });
      await cp(join(old, 'connectors'), join(next, 'connectors'), {
        recursive: true,
      });
      carried.push('connectors');
    }
    if (
      (await exists(join(old, 'browser-tools'))) &&
      !(await exists(join(next, 'browser-tools')))
    ) {
      await mkdir(next, { recursive: true });
      await rename(join(old, 'browser-tools'), join(next, 'browser-tools'));
      carried.push('browser-tools');
    }
  }
  return carried;
}
