import { expect, it } from 'vitest';
import type { RuntimeAdapter } from '../src/core/runtimes/types';
import { MemoryStore } from '../src/core/memoryStore';
import { ChatService } from '../src/core/chat';
import { FakeRuntime } from '../src/core/runtimes/fake';
it('persists a server-assigned session ID and resumes it after reload', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('A');
  await store.patchAgent(id, { runtime: 'fake' });
  const assigned = '33333333-3333-4333-8333-333333333333';
  const runtime = new FakeRuntime(() => [
    { type: 'session', sessionId: assigned },
    { type: 'done', text: 'ok', isError: false },
  ]);
  const options = {
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
  };
  const first = new ChatService(options);
  await first.initialize();
  await first.send(id, 'one');
  await first.dispose();
  const second = new ChatService(options);
  await second.initialize();
  await second.send(id, 'two');
  expect(runtime.requests.at(-1)).toMatchObject({
    sessionId: assigned,
    resume: true,
  });
  await second.dispose();
});
it.each(['hermes', 'opencode', 'codex'] as const)(
  'runs mixed %s-worker/Claude-verifier orchestration on the shared queue using fake adapters',
  async (workerRuntime) => {
    const store = new MemoryStore();
    const lead = await store.createAgent('Lead'),
      worker = await store.createAgent('Worker'),
      reviewer = await store.createAgent('Reviewer');
    await store.patchAgent(lead, { runtime: 'claude-code' });
    await store.patchAgent(worker, {
      runtime: workerRuntime,
      verifier: reviewer,
    });
    await store.patchAgent(reviewer, { runtime: 'claude-code' });
    await store.setManager(worker, lead);
    const claude = new FakeRuntime((req) => [
      {
        type: 'done',
        isError: false,
        text: req.prompt.startsWith('Results from your team:')
          ? 'All done'
          : req.prompt.startsWith('Verify task:')
            ? '```agenthq-verdict\n{"verdict":"pass","feedback":"correct"}\n```'
            : '```agenthq-delegate\n{"tasks":[{"to":"Worker","task":"Say ok","verifyWith":"Reviewer","maxAttempts":1}]}\n```',
      },
    ]);
    const hermes = new FakeRuntime(() => [
      { type: 'done', text: 'ok', isError: false },
    ]);
    const adapters: RuntimeAdapter[] = [
      {
        id: 'claude-code',
        displayName: 'Claude fake',
        detect: claude.detect.bind(claude),
        start: claude.start.bind(claude),
      },
      {
        id: workerRuntime,
        displayName: 'Hermes fake',
        detect: hermes.detect.bind(hermes),
        start: hermes.start.bind(hermes),
      },
    ];
    const service = new ChatService({
      store,
      adapters,
      settings: () => ({ allowedFolders: [], maxParallelRuns: 1 }),
      vaultBasePath: '/vault',
      managedRoot: 'Obi-I',
    });
    await service.initialize();
    await service.send(lead, 'delegate');
    expect((await store.loadTasks())[0]?.frontmatter).toMatchObject({
      status: 'passed',
      runtimeId: workerRuntime,
      verifierRuntimeId: 'claude-code',
    });
    expect(hermes.requests).toHaveLength(1);
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
    await service.dispose();
  },
);
