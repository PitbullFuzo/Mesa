import { describe, expect, it, vi } from 'vitest';
import { ChatService, type ChatSnapshot } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RunEvent } from '../src/core/runtimes/types';

async function setup(maxParallelRuns = 2) {
  const store = new MemoryStore();
  await store.saveGroups([{ id: 'team', name: 'Team', color: '#112233' }]);
  const ids: string[] = [];
  for (const name of ['One', 'Two', 'Three', 'Outsider']) {
    const id = await store.createAgent(name);
    await store.patchAgent(id, {
      runtime: 'fake',
      group: name === 'Outsider' ? null : 'team',
    });
    ids.push(id);
  }
  const runtime = new FakeRuntime([], 1);
  const snapshots: ChatSnapshot[] = [];
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  await service.initialize();
  return { service, store, ids, runtime, snapshots };
}

describe('broadcast', () => {
  it('uses the current offline detection reason rather than a previous chat failure', async () => {
    const { service, ids, runtime } = await setup();
    vi.spyOn(runtime, 'start').mockImplementationOnce(() => {
      throw new Error('Old launch failure');
    });
    await expect(service.send(ids[0]!, 'First')).rejects.toThrow(
      'Old launch failure',
    );
    vi.spyOn(runtime, 'detect').mockResolvedValue({
      available: false,
      hint: 'Executable was removed',
    } as Awaited<ReturnType<typeof runtime.detect>>);
    await service.refreshRuntimes();
    await service.broadcast({ kind: 'agent', id: ids[0]! }, 'Hello');
    expect(service.getSnapshot().broadcast!.recipients[0]).toMatchObject({
      status: 'skipped',
      reason: 'Executable was removed',
    });
  });
  it('cancels admission while the shared queue is still stopping a normal run', async () => {
    const { service, ids, runtime } = await setup(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(runtime, 'start').mockImplementation((request) => {
      runtime.requests.push(request);
      return {
        stop: async () => {
          await gate;
        },
      };
    });
    const normal = service.send(ids[3]!, 'Normal');
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    const stopped = service.stopAll();
    const broadcast = service.broadcast(
      { kind: 'agent', id: ids[0]! },
      'Broadcast',
    );
    await broadcast;
    release();
    await Promise.all([normal, stopped]);
    expect(service.getSnapshot().broadcast!.recipients[0]).toMatchObject({
      status: 'cancelled',
    });
    expect(runtime.requests).toHaveLength(1);
  });

  it('reports thrown runtime starts as errors and continues other recipients', async () => {
    const { service, runtime } = await setup();
    vi.spyOn(runtime, 'start').mockImplementationOnce(() => {
      throw new Error('Launch failed');
    });
    await service.broadcast({ kind: 'group', id: 'team' }, 'Hello');
    expect(
      service.getSnapshot().broadcast!.recipients.map((entry) => entry.status),
    ).toEqual(['error', 'replied', 'replied']);
    expect(service.getSnapshot().broadcast!.recipients[0]?.reason).toBe(
      'Launch failed',
    );
  });

  it('Stop on a queued recipient cancels only that recipient', async () => {
    const { service, ids, runtime } = await setup(1);
    const callbacks: ((event: RunEvent) => void)[] = [];
    vi.spyOn(runtime, 'start').mockImplementation((request, callback) => {
      runtime.requests.push(request);
      callbacks.push(callback);
      return { stop: async () => {} };
    });
    const broadcast = service.broadcast({ kind: 'group', id: 'team' }, 'Hello');
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await service.stop(ids[1]!);
    callbacks[0]!({ type: 'done', text: 'First', isError: false });
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[1]!({ type: 'done', text: 'Third', isError: false });
    await broadcast;
    expect(
      service.getSnapshot().broadcast!.recipients.map((entry) => entry.status),
    ).toEqual(['replied', 'cancelled', 'replied']);
  });
  it.each(['stopAll', 'dispose'] as const)(
    'cancels a broadcast still loading targets on %s',
    async (method) => {
      const { service, store, runtime } = await setup();
      const original = store.loadAgents.bind(store);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(store, 'loadAgents').mockImplementationOnce(async () => {
        await gate;
        return original();
      });
      const pending = service.broadcast({ kind: 'everyone' }, 'Hello');
      await service[method]();
      release();
      await pending;
      expect(runtime.requests).toHaveLength(0);
      expect(service.getSnapshot().broadcast).toMatchObject({ running: false });
      expect(
        service
          .getSnapshot()
          .broadcast!.recipients.every((entry) => entry.status === 'cancelled'),
      ).toBe(true);
    },
  );

  it('marks both running and queued turns cancelled on Stop all', async () => {
    const { service, ids, runtime, store } = await setup(1);
    const start = vi.spyOn(runtime, 'start').mockImplementation((request) => {
      runtime.requests.push(request);
      return { stop: async () => {} };
    });
    const pending = service.broadcast({ kind: 'group', id: 'team' }, 'Hello');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await service.stopAll();
    await pending;
    expect(
      service.getSnapshot().broadcast!.recipients.map((entry) => entry.status),
    ).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
    expect(runtime.requests).toHaveLength(1);
    expect(
      (await store.loadChats()).map(
        (note) => (note.frontmatter as { agentId: string }).agentId,
      ),
    ).toEqual([ids[0]]);
  });

  it('reports its own runtime error even when another normal turn for that agent starts', async () => {
    const { service, ids, runtime } = await setup(1);
    const callbacks: ((event: RunEvent) => void)[] = [];
    vi.spyOn(runtime, 'start').mockImplementation((request, callback) => {
      runtime.requests.push(request);
      callbacks.push(callback);
      return { stop: async () => {} };
    });
    const pending = service.broadcast(
      { kind: 'agent', id: ids[0]! },
      'Broadcast',
    );
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    const normal = service.send(ids[0]!, 'Normal');
    callbacks[0]!({
      type: 'done',
      text: 'Authentication expired',
      isError: true,
      errorKind: 'auth',
    });
    await pending;
    expect(service.getSnapshot().broadcast!.recipients[0]).toMatchObject({
      status: 'error',
      reason: 'Authentication expired',
    });
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[1]!({ type: 'done', text: 'Normal success', isError: false });
    await normal;
    expect(service.getSnapshot().broadcast!.recipients[0]?.status).toBe(
      'error',
    );
  });

  it.each(['initial', 'reply'] as const)(
    'reports %s persistence errors instead of replied',
    async (phase) => {
      const { service, ids, store, runtime } = await setup();
      const original = store.saveNote.bind(store);
      vi.spyOn(store, 'saveNote').mockImplementation(async (path, fm, body) => {
        if (
          path.includes('/Chats/') &&
          (phase === 'initial' || body.includes('Test reply:'))
        )
          throw new Error('Disk full');
        await original(path, fm, body);
      });
      await service.broadcast({ kind: 'agent', id: ids[0]! }, 'Hello');
      expect(service.getSnapshot().broadcast!.recipients[0]).toMatchObject({
        status: 'error',
        reason: 'Disk full',
      });
      expect(runtime.requests).toHaveLength(phase === 'initial' ? 0 : 1);
    },
  );
  it('rejects missing targets and blank text without replacing the latest completed result', async () => {
    const { service, store, ids, runtime } = await setup();
    await service.broadcast({ kind: 'agent', id: ids[0]! }, 'One only');
    const latest = service.getSnapshot().broadcast;
    await expect(
      service.broadcast({ kind: 'agent', id: 'missing' }, 'Hello'),
    ).rejects.toThrow('Unknown agent');
    await expect(
      service.broadcast({ kind: 'group', id: 'missing' }, 'Hello'),
    ).rejects.toThrow('Unknown group');
    await expect(service.broadcast({ kind: 'everyone' }, '  ')).rejects.toThrow(
      'Message cannot be empty',
    );
    await store.saveGroups([]);
    await expect(
      service.broadcast({ kind: 'group', id: 'team' }, 'Hello'),
    ).rejects.toThrow('Unknown group');
    expect(service.getSnapshot().broadcast).toEqual(latest);
    expect(runtime.requests).toHaveLength(1);
  });

  it('rejects overlapping broadcasts even during target loading', async () => {
    const { service, store, ids } = await setup();
    const original = store.loadAgents.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(store, 'loadAgents').mockImplementationOnce(async () => {
      await gate;
      return original();
    });
    const first = service.broadcast({ kind: 'agent', id: ids[0]! }, 'First');
    const overlap = service.broadcast({ kind: 'everyone' }, 'Second');
    release();
    await expect(overlap).rejects.toThrow(/broadcast.*progress/i);
    await first;
    expect(service.getSnapshot().broadcast?.text).toBe('First');
  });

  it('targets agent versus group by kind even when their IDs match, using current membership', async () => {
    const { service, store, ids, runtime } = await setup();
    await store.saveGroups([
      { id: ids[0]!, name: 'Same ID', color: '#112233' },
    ]);
    await store.patchAgent(ids[1]!, { group: ids[0]! });
    await service.broadcast({ kind: 'group', id: ids[0]! }, 'Group only');
    expect(
      service.getSnapshot().broadcast?.recipients.map((entry) => entry.agentId),
    ).toEqual([ids[1]]);
    await service.broadcast({ kind: 'agent', id: ids[0]! }, 'Agent only');
    expect(
      service.getSnapshot().broadcast?.recipients.map((entry) => entry.agentId),
    ).toEqual([ids[0]]);
    const added = await store.createAgent('New arrival');
    await store.patchAgent(added, { runtime: 'fake' });
    await service.broadcast({ kind: 'agent', id: added }, 'New only');
    expect(
      service.getSnapshot().broadcast?.recipients.map((entry) => entry.agentId),
    ).toEqual([added]);
    expect(runtime.requests.map((request) => request.prompt)).toEqual([
      'Group only',
      'Agent only',
      'New only',
    ]);
  });
  it('Everyone reads current notes and lists offline, malformed, full and forbidden-workdir skips with actual reasons', async () => {
    const { service, store, ids, runtime } = await setup();
    await store.patchAgent(ids[1]!, { runtime: 'ollama' });
    await store.patchAgent(ids[2]!, { permission: 'full' });
    await store.patchAgent(ids[3]!, { workdir: '/outside' });
    await store.createNote(
      'Obi-I/Agents/Broken.md',
      { agenthq: 'agent', id: [] },
      '',
    );
    const current = await store.loadAgents();
    await service.broadcast({ kind: 'everyone' }, 'Hello');
    const result = service.getSnapshot().broadcast!;
    expect(result.running).toBe(false);
    expect(result.recipients).toHaveLength(5);
    expect(new Set(result.recipients.map((entry) => entry.key)).size).toBe(5);
    expect(
      result.recipients.find((entry) => entry.agentId === ids[0])?.status,
    ).toBe('replied');
    for (const id of ids.slice(1)) {
      const recipient = result.recipients.find((entry) => entry.agentId === id);
      expect(recipient?.status).toBe('skipped');
      expect(typeof recipient?.reason).toBe('string');
    }
    expect(
      result.recipients.find((entry) => entry.agentId === ids[1])?.reason,
    ).toMatch(/runtime unavailable/i);
    expect(
      result.recipients.find((entry) => entry.agentId === ids[2])?.reason,
    ).toContain('Full permission');
    expect(
      result.recipients.find((entry) => entry.agentId === ids[3])?.reason,
    ).toMatch(/allowed/i);
    expect(
      result.recipients.find((entry) => entry.name === 'Broken'),
    ).toMatchObject({
      key: 'Obi-I/Agents/Broken.md',
      status: 'skipped',
      reason: current.invalidAgents[0]!.reason,
    });
    expect(runtime.requests).toHaveLength(1);
    // Step 7 persists the refused workdir turn so its Inbox record has a real note link.
    expect(await store.loadChats()).toHaveLength(2);
    expect(service.getSnapshot().inbox).toEqual([
      expect.objectContaining({ kind: 'workdir-not-allowed', agentId: ids[3] }),
    ]);
  });
  it('persists three group replies in their own chats through the normal shared queue', async () => {
    const { service, store, ids, runtime, snapshots } = await setup();
    await Promise.all([
      service.broadcast({ kind: 'group', id: 'team' }, 'Team hello'),
      service.send(ids[3]!, 'Normal hello'),
    ]);
    const result = service.getSnapshot().broadcast!;
    expect(result).toMatchObject({
      target: { kind: 'group', id: 'team' },
      text: 'Team hello',
      running: false,
    });
    expect(result.recipients.map((entry) => entry.agentId).sort()).toEqual(
      ids.slice(0, 3).sort(),
    );
    expect(
      result.recipients.map((entry) => ({
        status: entry.status,
        reason: entry.reason,
      })),
    ).toEqual([
      { status: 'replied', reason: undefined },
      { status: 'replied', reason: undefined },
      { status: 'replied', reason: undefined },
    ]);
    expect(runtime.requests).toHaveLength(4);
    expect(
      Math.max(...snapshots.map((snapshot) => snapshot.queue.running)),
    ).toBe(2);
    expect(
      snapshots.some(
        (snapshot) => snapshot.broadcast?.running && snapshot.queue.queued > 0,
      ),
    ).toBe(true);
    const chats = await store.loadChats();
    expect(chats).toHaveLength(4);
    for (const id of ids) {
      const chat = chats.find(
        (note) => (note.frontmatter as { agentId: string }).agentId === id,
      )!;
      const text = id === ids[3] ? 'Normal hello' : 'Team hello';
      expect(chat.body).toContain(`Test reply: ${text}`);
      expect(chat.body).not.toContain(
        id === ids[3] ? 'Team hello' : 'Normal hello',
      );
    }
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.broadcast?.recipients.some(
            (entry) => entry.status === 'replied',
          ) && snapshot.broadcast.running,
      ),
    ).toBe(true);
  });
});
