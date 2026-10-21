import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import { loadSettings } from '../src/core/settings';
import { initializeStarterTeam } from '../src/core/starter';
import {
  decideTeamFolder,
  rebuildMapAfterRemoval,
  renameTeamFolder,
  TeamFolderGuard,
  type TeamFolderCheck,
} from '../src/core/teamFolder';

/** A vault with folders, some of which hold a team. Renaming moves a folder, as Obsidian does. */
function vault(folders: Record<string, boolean>) {
  const state = { ...folders };
  const check: TeamFolderCheck = {
    exists: async (path) => path in state,
    hasTeam: async (folder) => state[folder] === true,
  };
  const rename = async (from: string, to: string) => {
    if (!(from in state)) throw new Error(`The folder ${from} was not found.`);
    state[to] = state[from]!;
    delete state[from];
  };
  return { state, check, rename };
}

describe('the exact owner sequence', () => {
  it('reproduces the bug: a setting left at AgentHQ after the folder moved makes a second team', async () => {
    const store = new MemoryStore();
    // The team lives in Mesa (the folder was renamed) ...
    expect(await initializeStarterTeam(store, 'Mesa')).toBe(true);
    // ... but the setting still says AgentHQ, so the old startup made a fresh team there.
    expect(await initializeStarterTeam(store, 'AgentHQ')).toBe(true);
    expect(await store.exists('AgentHQ/Agents/CEO.md')).toBe(true);
    expect(await store.exists('Mesa/Agents/CEO.md')).toBe(true);
  });

  it('now: renaming saves the setting, and the reload uses Mesa with no new AgentHQ', async () => {
    const { state, check, rename } = vault({ AgentHQ: true });
    let saved: unknown = { agenthqFolder: 'AgentHQ' };
    const settings = loadSettings(saved);
    await renameTeamFolder({
      settings,
      to: 'Mesa',
      rename,
      save: async () => {
        saved = JSON.parse(JSON.stringify(settings));
      },
    });
    expect(settings.agenthqFolder).toBe('Mesa');
    // Reload: the saved data decides, not the memory of the old run.
    const reloaded = loadSettings(saved);
    expect(reloaded.agenthqFolder).toBe('Mesa');
    expect(await decideTeamFolder(reloaded.agenthqFolder, check)).toEqual({
      action: 'use',
      folder: 'Mesa',
    });
    expect(Object.keys(state)).toEqual(['Mesa']);
  });

  it('now: if the setting is still AgentHQ after the move, the team in Mesa is offered, and nothing is created', async () => {
    const { state, check } = vault({ Mesa: true });
    expect(await decideTeamFolder('AgentHQ', check)).toEqual({
      action: 'offer',
      folder: 'AgentHQ',
      found: 'Mesa',
    });
    expect(Object.keys(state)).toEqual(['Mesa']);
  });
});

describe('renaming the team folder', () => {
  it('leaves the setting alone when the rename fails', async () => {
    const { state, rename } = vault({});
    const settings = { agenthqFolder: 'AgentHQ' };
    let saves = 0;
    await expect(
      renameTeamFolder({
        settings,
        to: 'Mesa',
        rename,
        save: async () => void saves++,
      }),
    ).rejects.toThrow(/not found/);
    expect(settings.agenthqFolder).toBe('AgentHQ');
    expect(saves).toBe(0);
    expect(state).toEqual({});
  });

  it('puts the folder and the setting back if saving fails (nothing is deleted)', async () => {
    const { state, rename } = vault({ AgentHQ: true });
    const settings = { agenthqFolder: 'AgentHQ' };
    await expect(
      renameTeamFolder({
        settings,
        to: 'Mesa',
        rename,
        save: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(settings.agenthqFolder).toBe('AgentHQ');
    expect(state).toEqual({ AgentHQ: true });
  });
});

describe('where the team is looked for', () => {
  it('offers the folder that holds a team, whichever it is', async () => {
    const { check } = vault({ AgentHQ: true });
    expect(await decideTeamFolder('Mesa', check)).toEqual({
      action: 'offer',
      folder: 'Mesa',
      found: 'AgentHQ',
    });
  });

  it('makes a starter team only when no team exists anywhere', async () => {
    const empty = vault({});
    expect(await decideTeamFolder('Mesa', empty.check)).toEqual({
      action: 'create',
      folder: 'Mesa',
    });
    // A folder without agent notes is not a team.
    const noTeam = vault({ AgentHQ: false });
    expect(await decideTeamFolder('Mesa', noTeam.check)).toEqual({
      action: 'create',
      folder: 'Mesa',
    });
  });

  it('uses the configured folder when it exists, even if another holds a team', async () => {
    const { check } = vault({ Mesa: false, AgentHQ: true });
    expect(await decideTeamFolder('Mesa', check)).toEqual({
      action: 'use',
      folder: 'Mesa',
    });
  });
});

describe('the map handler during a rename', () => {
  const names = ['Vault map.md', 'Graph map.md'];

  /** The rename button, with the map handler listening for the rename event of AgentHQ/Vault map.md. */
  async function renameWithHandler(guarded: boolean) {
    const { state, check, rename } = vault({ AgentHQ: true });
    const guard = new TeamFolderGuard();
    const rebuilt: string[] = [];
    // What the map writer does when it runs: it writes into the configured root, creating the folder if needed.
    const rebuild = async () => {
      state['AgentHQ'] = true;
      rebuilt.push('Vault map.md');
    };
    const settings = { agenthqFolder: 'AgentHQ' };
    if (guarded) guard.begin();
    await renameTeamFolder({
      settings,
      to: 'Mesa',
      rename: async (from, to) => {
        await rename(from, to);
        // Obsidian fires the rename event for each child while the folder moves.
        await rebuildMapAfterRemoval({
          path: 'AgentHQ/Vault map.md',
          root: 'AgentHQ',
          mapNames: names,
          guard,
          exists: (path) => check.exists(path),
          rebuild,
        });
      },
      save: async () => {},
    });
    return { state, rebuilt };
  }

  it('does not recreate AgentHQ when the rename event of its map arrives', async () => {
    const { state, rebuilt } = await renameWithHandler(true);
    expect(rebuilt).toEqual([]);
    expect(Object.keys(state)).toEqual(['Mesa']);
  });

  it('never recreates a root that no longer exists, even without the guard', async () => {
    const { state, rebuilt } = await renameWithHandler(false);
    expect(rebuilt).toEqual([]);
    expect(Object.keys(state)).toEqual(['Mesa']);
  });

  it('still rebuilds a removed map in a root that exists, and ignores other files', async () => {
    const { check } = vault({ Mesa: true });
    const guard = new TeamFolderGuard();
    let rebuilt = 0;
    const call = (path: string) =>
      rebuildMapAfterRemoval({
        path,
        root: 'Mesa',
        mapNames: names,
        guard,
        exists: (path) => check.exists(path),
        rebuild: async () => void rebuilt++,
      });
    expect(await call('Mesa/Vault map.md')).toBe(true);
    expect(await call('Mesa/Notes/other.md')).toBe(false);
    guard.begin();
    expect(await call('Mesa/Graph map.md')).toBe(false);
    guard.cancel();
    expect(await call('Mesa/Graph map.md')).toBe(true);
    expect(rebuilt).toBe(2);
  });
});
