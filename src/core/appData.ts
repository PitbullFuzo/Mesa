import { cp, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The plugin's id, which is also its folder in `<vault>/.obsidian/plugins/`. Permanent once published. */
export const PLUGIN_ID = 'obi-i';
/** What the plugin was called while it was tested: its plugin folder and its folder next to the user's app data. */
export const LEGACY_PLUGIN_ID = 'agenthq';
const LEGACY_APP_DATA = 'AgentHQ';
const APP_DATA = 'Obi-I';

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Carries the earlier app-data folder over once, so nothing has to be set up again: the Microsoft sign-in is copied
 * (the old folder is left as it was), and the browser tools, which can be large, are moved. Returns what was carried.
 */
export async function migrateAppData(
  base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
): Promise<string[]> {
  const old = join(base, LEGACY_APP_DATA);
  const next = join(base, APP_DATA);
  const carried: string[] = [];
  if (!(await exists(old))) return carried;
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
  return carried;
}
