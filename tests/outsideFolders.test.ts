import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import {
  agentOutsideFolders,
  excludedFilesWith,
  isFolderHidden,
  setFolderHidden,
  isExcluded,
  outputFolderProblem,
} from '../src/core/folders';
import { MemoryStore } from '../src/core/memoryStore';
import {
  createProjectNote,
  loadValidProjects,
  updateProjectNote,
} from '../src/core/projects';
import { resolveWorkdir } from '../src/core/workdir';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RuntimeAdapter } from '../src/core/runtimes/types';
import { GUIDE_BODY, GUIDE_VERSION } from '../src/core/guide';

const ALLOWED = ['Notes', 'Reference'];

describe('per-agent outside folders', () => {
  it('an agent with no list (made before this version) keeps every folder Settings allows', () => {
    expect(agentOutsideFolders({}, ALLOWED)).toEqual(ALLOWED);
  });

  it('a new agent with an empty list gets no outside folders', () => {
    expect(agentOutsideFolders({ outsideFolders: [] }, ALLOWED)).toEqual([]);
  });

  it('only the ticked folders reach the agent, and a ticked folder Settings no longer allows is dropped', () => {
    expect(
      agentOutsideFolders({ outsideFolders: ['Reference', 'Gone'] }, ALLOWED),
    ).toEqual(['Reference']);
  });

  it('an upgraded vault keeps all outside folders: a legacy agent note loads with no list, and so keeps them', async () => {
    const store = new MemoryStore('Obi-I');
    await store.createNote(
      'Obi-I/Agents/Legacy.md',
      {
        agenthq: 'agent',
        id: 'legacy',
        role: '',
        reportsTo: null,
        runtime: 'claude-code',
        permission: 'edit',
        group: null,
        model: '',
        vaultAccess: 'off',
        webAccess: true,
        wholeComputerReadConfirmed: false,
        canUseBrowser: false,
        workdir: '',
        verifier: null,
        skills: [],
      },
      'Old agent.',
    );
    const legacy = (await store.loadAgents()).agents.find(
      (agent) => agent.id === 'legacy',
    )!;
    expect(legacy.outsideFolders).toBeUndefined();
    expect(agentOutsideFolders(legacy, ALLOWED)).toEqual(ALLOWED);
  });

  it('a working folder outside the agent’s ticked folders is refused; a ticked one is allowed', async () => {
    const base = {
      agentId: 'coder',
      workdir: 'Reference/notes',
      vaultBasePath: 'C:\\Vault',
      managedRoot: 'Obi-I',
      allowedFolders: [] as string[],
    };
    await expect(resolveWorkdir(base)).rejects.toThrow(
      'outside allowed folders',
    );
    await expect(
      resolveWorkdir({ ...base, allowedFolders: ['Reference'] }),
    ).resolves.toMatchObject({ cwd: 'C:/Vault/Reference/notes' });
  });
});

describe('project Output folder', () => {
  it('is optional, and must be a plain folder inside the vault that is not protected', () => {
    expect(outputFolderProblem('', 'Obi-I', '.obsidian')).toBeUndefined();
    expect(
      outputFolderProblem('Projects/Sales output', 'Obi-I', '.obsidian'),
    ).toBeUndefined();
    expect(
      outputFolderProblem('Obi-I/Work/coder/out', 'Obi-I', '.obsidian'),
    ).toBeUndefined();
    expect(outputFolderProblem('../outside', 'Obi-I', '.obsidian')).toContain(
      'plain folder',
    );
    expect(outputFolderProblem('C:/Users/x', 'Obi-I', '.obsidian')).toContain(
      'inside the vault',
    );
    expect(
      outputFolderProblem('.obsidian/plugins', 'Obi-I', '.obsidian'),
    ).toContain('configuration');
    expect(outputFolderProblem('Obi-I', 'Obi-I', '.obsidian')).toContain(
      'protected',
    );
    expect(
      outputFolderProblem('Obi-I/Agents/x', 'Obi-I', '.obsidian'),
    ).toContain('protected');
  });

  it('a run writes to the output folder only for an agent assigned to that project', async () => {
    const store = new MemoryStore('Obi-I');
    const fake = new FakeRuntime(
      (request) => [
        {
          type: 'done',
          text: `reply ${request.prompt}`,
          isError: false,
          costUsd: 0,
        },
      ],
      0,
    );
    const adapter: RuntimeAdapter = fake;
    const assigned = await store.createAgent('Writer');
    const other = await store.createAgent('Other');
    await store.patchAgent(assigned, { runtime: 'fake' });
    await store.patchAgent(other, { runtime: 'fake' });
    const path = await createProjectNote(store, 'Obi-I', { name: 'Sales' });
    const project = loadValidProjects(await store.loadProjects()).find(
      (entry) => entry.path === path,
    )!;
    await updateProjectNote(store, project, {
      agents: [assigned],
      outputFolder: 'Output/Sales',
    });
    const projectId = loadValidProjects(await store.loadProjects())[0]!.id;
    const service = new ChatService({
      store,
      adapters: [adapter],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Obi-I',
      memoryDelayMs: 60_000,
    });
    await service.initialize();

    await service.send(assigned, 'write the report', projectId);
    expect(fake.requests.at(-1)!.extraDirs).toContain('/vault/Output/Sales');

    await service.send(other, 'anything', projectId);
    expect(fake.requests.at(-1)!.extraDirs).not.toContain(
      '/vault/Output/Sales',
    );
  });
});

describe('Hide Obi-I from search & graph', () => {
  it('adds the folder to Excluded files, keeps the other entries, and removes it again', () => {
    const added = excludedFilesWith(['Old/'], 'Obi-I', true);
    expect(added).toEqual(['Old/', 'Obi-I/']);
    expect(isExcluded(added, 'Obi-I')).toBe(true);
    expect(excludedFilesWith(added, 'Obi-I', true)).toEqual(added);
    const shown = excludedFilesWith(added, 'Obi-I', false);
    expect(shown).toEqual(['Old/']);
    expect(isExcluded(shown, 'Obi-I')).toBe(false);
  });
});

describe('the guide', () => {
  it('describes the outside folders, the Output folder and the hide setting, and is at version 4', () => {
    expect(GUIDE_VERSION).toBe(23);
    expect(GUIDE_BODY).toContain('outside folders you tick for that agent');
    expect(GUIDE_BODY).toContain('Output folder');
    expect(GUIDE_BODY).toContain('hide Obi-I from search and the graph');
  });
});

describe('the tour hide choice', () => {
  const fakeConfig = (initial: unknown) => {
    const store = new Map<string, unknown>([['userIgnoreFilters', initial]]);
    return {
      store,
      getConfig: (key: string) => store.get(key),
      setConfig: (key: string, value: unknown) => void store.set(key, value),
    };
  };

  it('"Hide it" adds the folder to Excluded files and keeps the other entries', () => {
    const config = fakeConfig(['Old/']);
    expect(isFolderHidden(config, 'Obi-I/')).toBe(false);
    setFolderHidden(config, 'Obi-I/', true);
    expect(config.store.get('userIgnoreFilters')).toEqual(['Old/', 'Obi-I/']);
    expect(isFolderHidden(config, 'Obi-I/')).toBe(true);
  });

  it('is not added twice, and "Show again" takes it out; "Keep it visible" changes nothing', () => {
    const config = fakeConfig(['Obi-I/']);
    setFolderHidden(config, 'Obi-I/', true);
    expect(config.store.get('userIgnoreFilters')).toEqual(['Obi-I/']);
    setFolderHidden(config, 'Obi-I/', false);
    expect(isFolderHidden(config, 'Obi-I/')).toBe(false);
    const untouched = fakeConfig(undefined);
    expect(isFolderHidden(untouched, 'Obi-I/')).toBe(false);
    expect(untouched.store.get('userIgnoreFilters')).toBeUndefined();
  });
});
