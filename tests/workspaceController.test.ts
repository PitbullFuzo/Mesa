import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { MemoryStore } from '../src/core/memoryStore';
import { WorkspaceController } from '../src/obsidian/workspaceController';
import { initializeStarterTeam } from '../src/core/starter';
import { ensureObi } from '../src/core/obi';
import { createProjectNote } from '../src/core/projects';
import type { ChatService } from '../src/core/chat';

// Controller regressions exercise real persistence with only host UI APIs stubbed.
vi.mock('obsidian', () => ({ Notice: class {} }));
vi.mock('../src/obsidian/modals', () => ({
  confirmAction: () => Promise.resolve(true),
  promptForName: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controller() {
  return new WorkspaceController({} as App, () => {});
}

describe('workspace layout persistence', () => {
  it('publishes live chat state and delegates chat actions, releasing subscriptions on dispose', async () => {
    const workspace = controller();
    const send = vi.fn(async () => {});
    const broadcast = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const stopAll = vi.fn(async () => {});
    const newConversation = vi.fn(async () => {});
    const resolveInbox = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    let change!: (snapshot: import('../src/core/chat').ChatSnapshot) => void;
    const snapshot = {
      agents: {},
      runtimes: {},
      queue: { running: 1, queued: 2 },
    };
    workspace.attachChat({
      chatNotes: vi.fn(async () => []),
      deleteChats: vi.fn(async () => 0),
      projectBusy: vi.fn(() => false),
      tickSchedules: vi.fn(async () => {}),
      forkChat: vi.fn(async () => ''),
      resolveCommand: vi.fn(),
      runScheduleNow: vi.fn(async () => {}),
      resumeSchedule: vi.fn(async () => {}),
      startLoop: vi.fn(async () => ({
        status: 'completed' as const,
        rounds: 0,
        costUsd: 0,
      })),
      projectMemoryInfo: vi.fn(async () => ({
        model: 'Off',
        notes: 0,
        lastContextWords: null,
      })),
      continueChat: vi.fn(async () => {}),
      resolveProposal: vi.fn(),
      renameChat: vi.fn(async () => {}),
      refreshAgents: vi.fn(async () => {}),
      send,
      broadcast,
      stop,
      stopAll,
      newConversation,
      resolveInbox,
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        change = listener;
        return unsubscribe;
      },
    });
    expect(workspace.getSnapshot().chat).toEqual(snapshot);
    await workspace.sendMessage('agent', 'hello');
    await workspace.broadcast({ kind: 'group', id: 'core' }, 'team hello');
    await workspace.stopAgent('agent');
    await workspace.stopAll();
    await workspace.newConversation('agent');
    await workspace.resolveInbox('item', 'accept');
    expect(resolveInbox).toHaveBeenCalledWith('item', 'accept');
    expect(send).toHaveBeenCalledWith('agent', 'hello', undefined);
    expect(broadcast).toHaveBeenCalledWith(
      { kind: 'group', id: 'core' },
      'team hello',
      undefined,
    );
    expect(stop).toHaveBeenCalledWith('agent');
    expect(stopAll).toHaveBeenCalledOnce();
    expect(newConversation).toHaveBeenCalledWith('agent');
    change({ ...snapshot, queue: { running: 0, queued: 0 } });
    expect(workspace.getSnapshot().chat?.queue.running).toBe(0);
    workspace.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('publishes a fresh selection revision even when reselecting the same agent', async () => {
    const store = new MemoryStore();
    const id = await store.createAgent('Selected');
    const workspace = controller();
    await workspace.initialize(store);
    workspace.selectAgent(id);
    expect(workspace.getSnapshot()).toMatchObject({
      selectedId: id,
      selectionRevision: 1,
    });
    workspace.selectAgent(id);
    expect(workspace.getSnapshot()).toMatchObject({
      selectedId: id,
      selectionRevision: 2,
    });
  });
  it('retains invalid and unknown positions through creation, repair, moves and explicit deletion', async () => {
    const store = new MemoryStore();
    const id = await store.createAgent('Temporarily broken');
    const path = 'Mesa/Agents/Temporarily broken.md';
    const note = store.notes.get(path)!;
    note.frontmatter = {
      ...(note.frontmatter as Record<string, unknown>),
      permission: 'oops',
    };
    const saved = { [id]: { x: 987, y: -654 }, unknown: { x: 8, y: 9 } };
    await store.saveLayout(saved);
    const workspace = controller();
    await workspace.initialize(store);
    const newId = await workspace.createAgent('New agent');
    expect(await store.loadLayout()).toMatchObject(saved);
    const groupId = await workspace.createGroup('New group', '#123456');
    expect(await store.loadLayout()).toMatchObject(saved);
    note.frontmatter = {
      ...(note.frontmatter as Record<string, unknown>),
      permission: 'edit',
    };
    await workspace.refresh();
    expect(
      workspace.getSnapshot().agents.some((agent) => agent.id === id),
    ).toBe(true);
    expect(workspace.getSnapshot().layout[id]).toEqual(saved[id]);
    // A key saved outside the current controller snapshot must survive the next write too.
    await store.saveLayout({
      ...(await store.loadLayout()),
      outside: { x: 11, y: 22 },
    });
    await workspace.moveAgent(newId, { x: 1, y: 2 });
    expect(await store.loadLayout()).toMatchObject({
      ...saved,
      outside: { x: 11, y: 22 },
    });
    await workspace.deleteGroup(groupId);
    const afterGroupDelete = await store.loadLayout();
    expect(afterGroupDelete).not.toHaveProperty(`group:${groupId}`);
    expect(afterGroupDelete).toMatchObject(saved);
    await workspace.deleteAgent(newId);
    expect(await store.loadLayout()).not.toHaveProperty(newId);
    expect(await store.loadLayout()).toMatchObject({
      ...saved,
      outside: { x: 11, y: 22 },
    });
  });
  it('does not write layout when initialization refresh is superseded', async () => {
    const store = new MemoryStore();
    await store.createAgent('Existing');
    const saved = { existing: { x: 123, y: 456 }, unknown: { x: -9, y: 8 } };
    await store.saveLayout(saved);
    const collection = await store.loadAgents();
    const first = deferred<typeof collection>();
    const second = deferred<typeof collection>();
    const entered = deferred<void>();
    const reads = vi.spyOn(store, 'loadAgents');
    reads.mockImplementationOnce(() => {
      entered.resolve();
      return first.promise;
    });
    reads.mockImplementationOnce(() => second.promise);
    const writes = vi.spyOn(store, 'saveLayout');
    const workspace = controller();
    const initializing = workspace.initialize(store);
    await entered.promise;
    const refreshing = workspace.refresh();
    first.resolve(collection);
    await initializing;
    second.resolve(collection);
    await refreshing;
    expect(writes).not.toHaveBeenCalled();
    expect(await store.loadLayout()).toEqual(saved);
    expect(workspace.getSnapshot().layout).toEqual(saved);
    expect(workspace.getSnapshot().agents.map((agent) => agent.id)).toEqual([
      'existing',
    ]);
  });
});

describe('approved Obi changes keep Obi in its own tab', () => {
  it('opens the changed agent beside Obi and resolves the card without selecting Obi', async () => {
    const store = new MemoryStore('Mesa');
    await initializeStarterTeam(store, 'Mesa');
    await ensureObi(store, 'Mesa');
    const opened: [string, unknown][] = [];
    const resolveProposal = vi.fn();
    const workspace = new WorkspaceController(
      {} as App,
      (id, options) => {
        opened.push([id, options]);
      },
      async () => [],
    );
    await workspace.initialize(store);
    const proposal = {
      id: 'p1',
      action: { type: 'updateAgent', id: 'coder', role: 'Lead engineer' },
      title: 'Update Coder',
      fields: [],
      texts: [],
    };
    workspace.attachChat({
      getSnapshot: () => ({
        agents: { obi: { proposals: [proposal] } },
        runtimes: {},
        queue: { running: 0, queued: 0 },
      }),
      subscribe: () => () => undefined,
      resolveProposal,
      refreshAgents: vi.fn(async () => {}),
    } as unknown as Parameters<WorkspaceController['attachChat']>[0]);

    await workspace.approveProposal('obi', 'p1');

    expect(opened).toEqual([['coder', { tab: 'setup' }]]);
    expect(resolveProposal).toHaveBeenCalledWith('obi', 'p1');
    expect(workspace.getSnapshot().selectedId).not.toBe('obi');
    const coder = (await store.loadAgents()).agents.find(
      (agent) => agent.id === 'coder',
    );
    expect(coder?.role).toBe('Lead engineer');
  });
});

describe('deleting a project', () => {
  it('trashes the project note, and refuses while a request in that project runs', async () => {
    const store = new MemoryStore('Mesa');
    await initializeStarterTeam(store, 'Mesa');
    const path = await createProjectNote(store, 'Mesa', { name: 'Launch' });
    const workspace = controller();
    const busy = vi.fn(() => true);
    workspace.attachChat({
      projectBusy: busy,
      getSnapshot: () => ({
        agents: {},
        runtimes: {},
        queue: { running: 0, queued: 0 },
      }),
      subscribe: () => () => {},
    } as unknown as ChatService);
    await workspace.initialize(store);
    await expect(workspace.deleteProject(path)).rejects.toThrow(
      'running reply',
    );
    expect(await store.exists(path)).toBe(true);

    busy.mockReturnValue(false);
    await workspace.deleteProject(path);
    expect(await store.exists(path)).toBe(false);
  });
});

describe('projects board', () => {
  it('persists a status change from the board and publishes each project Log summary', async () => {
    const store = new MemoryStore('Mesa');
    await initializeStarterTeam(store, 'Mesa');
    const path = await createProjectNote(store, 'Mesa', { name: 'Launch' });
    const workspace = controller();
    await workspace.initialize(store);
    await workspace.setProjectStatus(path, 'done');
    const [note] = (await store.loadProjects()).filter(
      (entry) => entry.path === path,
    );
    expect((note!.frontmatter as { status: string }).status).toBe('done');
    const snapshot = workspace.getSnapshot();
    const project = snapshot.projects?.find((entry) => entry.path === path);
    expect(project?.status).toBe('done');
    expect(snapshot.projectLogs?.[project!.id]).toEqual({
      memoryCostUsd: 0,
      lastActivity: null,
      tail: [],
    });
  });
});

describe('archived projects', () => {
  it('unarchives a project and it comes back to the pickers', async () => {
    const store = new MemoryStore('Mesa');
    await initializeStarterTeam(store, 'Mesa');
    const path = await createProjectNote(store, 'Mesa', {
      name: 'Old idea',
    });
    const workspace = controller();
    await workspace.initialize(store);
    await workspace.setProjectArchived(path, true);
    expect(
      workspace.getSnapshot().projects?.find((entry) => entry.path === path)
        ?.archived,
    ).toBe(true);
    await workspace.setProjectArchived(path, false);
    const note = (await store.loadProjects()).find(
      (entry) => entry.path === path,
    );
    expect((note!.frontmatter as { archived: boolean }).archived).toBe(false);
    expect(
      workspace.getSnapshot().projects?.find((entry) => entry.path === path)
        ?.archived,
    ).toBe(false);
  });
});
