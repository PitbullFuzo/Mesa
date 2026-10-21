import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';

async function fixture(initiallyAvailable = true, delayMs = 20) {
  const store = new MemoryStore();
  const id = await store.createAgent('Worker');
  await store.patchAgent(id, { runtime: 'fake' });
  const runtime = new FakeRuntime([], delayMs);
  const detect = vi.spyOn(runtime, 'detect');
  if (!initiallyAvailable) detect.mockResolvedValueOnce({ available: false });
  const settings = { maxParallelRuns: 2, allowedFolders: [] as string[] };
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => settings,
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
  });
  await service.initialize();
  return { store, id, runtime, detect, service };
}

describe('cached runtime discovery', () => {
  it('rechecks once if a queued turn finds its runtime unavailable after a path change', async () => {
    const { service, id, runtime } = await fixture(true, 100);
    const first = service.send(id, 'first');
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1));
    const second = service.send(id, 'queued');
    const replacement = new FakeRuntime();
    const detect = vi
      .spyOn(replacement, 'detect')
      .mockResolvedValueOnce({ available: false });
    await service.setRuntimeAdapters([replacement]);
    await Promise.all([first, second]);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(replacement.requests).toHaveLength(1);
  });

  it('re-detects the selected runtime, not all adapters, when an agent changes runtime', async () => {
    const { service, store, id, runtime, detect } = await fixture();
    const otherDetect = vi.fn(async () => ({ available: true }));
    await service.setRuntimeAdapters([
      runtime,
      {
        id: 'ollama',
        displayName: 'Other',
        detect: otherDetect,
        start: runtime.start.bind(runtime),
      },
    ]);
    detect.mockClear();
    otherDetect.mockClear();
    await store.patchAgent(id, { runtime: 'ollama' });
    await service.refreshAgents();
    expect(otherDetect).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
    await service.refreshAgents();
    expect(otherDetect).toHaveBeenCalledTimes(1);
  });

  it('re-detects an unavailable delegated-task runtime without probing the lead again', async () => {
    const store = new MemoryStore();
    const lead = await store.createAgent('Lead');
    const worker = await store.createAgent('Worker');
    await store.patchAgent(lead, { runtime: 'fake' });
    await store.patchAgent(worker, { runtime: 'openrouter' });
    await store.setManager(worker, lead);
    const runtime = new FakeRuntime((request) => [
      {
        type: 'done',
        isError: false,
        text:
          request.prompt === 'delegate'
            ? '```agenthq-delegate\n{"tasks":[{"to":"Worker","task":"Say done"}]}\n```'
            : 'All done',
      },
    ]);
    const workerRuntime = new FakeRuntime();
    const leadDetect = vi.spyOn(runtime, 'detect');
    const workerDetect = vi
      .fn(async () => ({ available: true }))
      .mockResolvedValueOnce({ available: false });
    const service = new ChatService({
      store,
      adapters: [
        runtime,
        {
          id: 'openrouter',
          displayName: 'Worker',
          detect: workerDetect,
          start: workerRuntime.start.bind(workerRuntime),
        },
      ],
      settings: () => ({ maxParallelRuns: 2, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Obi-I',
    });
    await service.initialize();
    await service.send(lead, 'delegate');
    expect(workerDetect).toHaveBeenCalledTimes(2);
    expect(leadDetect).toHaveBeenCalledTimes(1);
    expect(workerRuntime.requests).toHaveLength(1);
    expect(service.getSnapshot().tasks?.[0]?.frontmatter).toMatchObject({
      status: 'passed',
    });
  });

  it('coalesces concurrent on-demand checks for the same offline runtime', async () => {
    const { service, store, id, detect, runtime } = await fixture(false);
    const other = await store.createAgent('Other');
    await store.patchAgent(other, { runtime: 'fake' });
    await service.refreshAgents();
    // Selecting the runtime for a new agent refreshes it; make it offline again.
    detect.mockResolvedValueOnce({ available: false });
    await service.refreshRuntimes();
    const before = detect.mock.calls.length;
    await Promise.all([service.send(id, 'one'), service.send(other, 'two')]);
    expect(detect).toHaveBeenCalledTimes(before + 1);
    expect(runtime.requests).toHaveLength(2);
  });

  it.each(['send', 'broadcast'] as const)(
    're-detects an unavailable runtime once for %s and proceeds when installed',
    async (kind) => {
      const { id, detect, runtime, service } = await fixture(false);
      if (kind === 'send') await service.send(id, 'hello');
      else await service.broadcast({ kind: 'agent', id }, 'hello');
      expect(runtime.requests).toHaveLength(1);
      expect(detect).toHaveBeenCalledTimes(2);
      expect(service.getSnapshot().agents[id]!.status).toBe('idle');
      await service.send(id, 'cached');
      expect(detect).toHaveBeenCalledTimes(2);
    },
  );

  it('re-detects only once before refusing a still-unavailable send', async () => {
    const { id, detect, runtime, service } = await fixture(false);
    detect.mockResolvedValue({ available: false });
    await expect(service.send(id, 'hello')).rejects.toThrow(
      'Runtime unavailable',
    );
    expect(detect).toHaveBeenCalledTimes(2);
    expect(runtime.requests).toHaveLength(0);
  });

  it('refreshes rapid managed-note changes without repeating detection', async () => {
    const { store, id, detect, service } = await fixture();
    expect(detect).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) {
      await store.saveNote(`Obi-I/Tasks/task-${i}.md`, {}, `Update ${i}`);
      await store.patchAgent(id, { role: `Role ${i}` });
      await service.refreshAgents();
    }
    expect(service.getSnapshot().agents[id]!.agent.role).toBe('Role 11');
    expect(detect).toHaveBeenCalledTimes(1);
  });
});
