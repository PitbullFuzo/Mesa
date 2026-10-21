import { describe, expect, it, vi } from 'vitest';
import { ChatService, type ChatServiceOptions } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';

const done = (text: string) => [
  { type: 'done' as const, text, isError: false, costUsd: 0.1 },
];
const verdict = (value: string, feedback: string) =>
  '```agenthq-verdict\n' +
  JSON.stringify({ verdict: value, feedback }) +
  '\n```';
async function setup(verdicts: string[], settings = {}) {
  const store = new MemoryStore();
  const lead = await store.createAgent('CEO');
  const worker = await store.createAgent('Coder');
  const reviewer = await store.createAgent('Reviewer');
  for (const id of [lead, worker, reviewer])
    await store.patchAgent(id, { runtime: 'fake' });
  await store.setManager(worker, lead);
  await store.setManager(reviewer, lead);
  await store.patchAgent(worker, { verifier: reviewer });
  let checks = 0;
  const runtime = new FakeRuntime(
    (request) =>
      done(
        request.prompt === 'Plan'
          ? '```agenthq-delegate\n{"tasks":[{"to":"Coder","task":"Build","maxAttempts":3}]}\n```'
          : request.prompt.startsWith('Verify task:')
            ? (verdicts[checks++] ?? verdict('fail', 'Still wrong'))
            : 'Answer ' + request.prompt,
      ),
    0,
  );
  let saved: unknown = [];
  const options: ChatServiceOptions = {
    store,
    adapters: [runtime],
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    settings: () => ({ maxParallelRuns: 1, allowedFolders: [], ...settings }),
    loadInbox: async () => saved,
    saveInbox: async (items) => {
      saved = structuredClone(items);
    },
  };
  const service = new ChatService(options);
  await service.initialize();
  return { service, store, runtime, lead, worker, reviewer, options };
}

describe('verification loop', () => {
  it('uses refreshed worker setup on Inbox retry without re-detecting cached runtimes', async () => {
    const { service, store, runtime, worker, lead } = await setup([]);
    const detect = vi.spyOn(runtime, 'detect');
    await service.send(lead, 'Plan');
    await store.patchAgent(worker, { model: 'new-model' });
    await service.refreshAgents();
    const before = runtime.requests.length;
    await service.resolveInbox(service.getSnapshot().inbox![0]!.id, 'retry');
    const workers = runtime.requests
      .slice(before)
      .filter((request) => request.prompt.startsWith('Verifier feedback:'));
    expect(workers.map((request) => request.model)).toEqual([
      'new-model',
      'new-model',
    ]);
    expect(detect).not.toHaveBeenCalled();
  });
  it('never silently passes an explicit unknown verifier; corrects once then creates an inbox record', async () => {
    const { service, runtime, lead } = await setup([]);
    vi.spyOn(runtime, 'start').mockImplementation((request, onEvent) => {
      runtime.requests.push(structuredClone(request));
      const timer = setTimeout(
        () =>
          onEvent({
            type: 'done',
            isError: false,
            text: '```agenthq-delegate\n{"tasks":[{"to":"Coder","task":"Build","verifyWith":"Missing"}]}\n```',
          }),
        0,
      );
      return {
        stop: async () => {
          clearTimeout(timer);
        },
      };
    });
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(2);
    expect(service.getSnapshot().tasks).toHaveLength(0);
    expect(service.getSnapshot().inbox![0]).toMatchObject({
      kind: 'invalid-delegation',
    });
  });
  it('retains exact verifier costs across missing-session recovery without corrupting the worker baseline', async () => {
    const { service, runtime, lead } = await setup([
      verdict('fail', 'Fix'),
      verdict('pass', 'Good'),
    ]);
    const start = runtime.start.bind(runtime);
    let rejected = false;
    vi.spyOn(runtime, 'start').mockImplementation((request, onEvent) => {
      if (
        request.prompt.startsWith('Verify task:') &&
        request.resume &&
        !rejected
      ) {
        rejected = true;
        runtime.requests.push(structuredClone(request));
        const timer = setTimeout(
          () =>
            onEvent({
              type: 'done',
              text: 'No conversation found',
              isError: true,
              costUsd: 0.02,
            }),
          0,
        );
        return {
          stop: async () => {
            clearTimeout(timer);
          },
        };
      }
      return start(request, onEvent);
    });
    await service.send(lead, 'Plan');
    const fm = service.getSnapshot().tasks![0]!.frontmatter as Record<
      string,
      unknown
    >;
    expect(fm).toMatchObject({
      status: 'passed',
      attempt: 2,
      costUsd: 0.2,
      verifierCostUsd: 0.1,
      workerTotalCostUsd: 0.2,
    });
    expect(fm.verifierTotalCostUsd).toBeCloseTo(0.22);
    expect(
      runtime.requests.filter((request) =>
        request.prompt.startsWith('Verify task:'),
      ),
    ).toHaveLength(3);
  });
  it('retry reports its final result back to the lead through the existing queued session', async () => {
    const { service, runtime, lead } = await setup([]);
    await service.send(lead, 'Plan');
    const leadSession = service.getSnapshot().agents[lead]!.session!.sessionId;
    const before = runtime.requests.length;
    await service.resolveInbox(service.getSnapshot().inbox![0]!.id, 'retry');
    const results = runtime.requests
      .slice(before)
      .filter((request) =>
        request.prompt.startsWith('Results from your team:'),
      );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ resume: true, sessionId: leadSession });
    expect(results[0]!.prompt).toContain('needs-you');
  });
  it('charges verifier and its recovery runs against the same request budget', async () => {
    const { service, runtime, lead } = await setup([], {
      maxRunsPerRequest: 3,
    });
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(3);
    expect(service.getSnapshot().inbox!.map((item) => item.kind)).toEqual([
      'run-limit',
    ]);
    expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
      status: 'needs-you',
      attempt: 2,
    });
  });
  it.each([
    ['Developer verification pass demo', 'passed', 3],
    ['Developer verification exhaust demo', 'needs-you', 3],
    ['Developer verification retry demo', 'needs-you', 3],
  ])(
    'provides a deterministic free developer scenario: %s',
    async (prompt, status, attempt) => {
      const { service, options, lead } = await setup([]);
      options.adapters = [new FakeRuntime([], 0)];
      await service.setRuntimeAdapters(options.adapters);
      await service.send(lead, String(prompt));
      expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
        status,
        attempt,
      });
      if (String(prompt).includes('retry')) {
        await service.resolveInbox(
          service.getSnapshot().inbox![0]!.id,
          'retry',
        );
        expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
          status: 'passed',
          attempt: 5,
          maxAttempts: 5,
        });
      }
    },
  );
  it('developer slow demo stays active until Stop all cancels its worker and queued siblings', async () => {
    const { service, options, lead, runtime } = await setup([]);
    const fake = new FakeRuntime([], 0);
    options.adapters = [fake];
    await service.setRuntimeAdapters([fake]);
    const sending = service.send(lead, 'Developer verification stop demo');
    await vi.waitFor(() => expect(fake.requests).toHaveLength(2));
    await service.stopAll();
    await sending;
    expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
      status: 'cancelled',
    });
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
    expect(runtime.requests).toHaveLength(0);
  });
  it('creates a linked runtime auth inbox item and dismisses it durably', async () => {
    const { service, runtime, lead, options } = await setup([]);
    const start = vi
      .spyOn(runtime, 'start')
      .mockImplementation((_request, onEvent) => {
        const timer = setTimeout(
          () =>
            onEvent({
              type: 'done',
              text: 'Sign in required',
              isError: true,
              errorKind: 'auth',
            }),
          0,
        );
        return {
          stop: async () => {
            clearTimeout(timer);
          },
        };
      });
    await service.send(lead, 'Hello');
    const item = service.getSnapshot().inbox![0]!;
    expect(item).toMatchObject({ kind: 'runtime-auth', agentId: lead });
    expect(item.path).toBeTruthy();
    expect(await options.store.exists(item.path!)).toBe(true);
    await service.resolveInbox(item.id, 'dismiss');
    expect(service.getSnapshot().agents[lead]!.status).toBe('idle');
    start.mockRestore();
  });
  it('creates a linked workdir refusal inbox item without starting inference', async () => {
    const { service, store, runtime, lead } = await setup([]);
    await store.patchAgent(lead, { workdir: 'Forbidden' });
    await service.refreshAgents();
    await expect(service.send(lead, 'Hello')).rejects.toThrow(/allow/i);
    const item = service.getSnapshot().inbox![0]!;
    expect(item).toMatchObject({ kind: 'workdir-not-allowed', agentId: lead });
    expect(await store.exists(item.path!)).toBe(true);
    expect(runtime.requests).toHaveLength(0);
  });
  it('Stop all during a retried verifier kills active and queued work and prevents subsequent attempts/results', async () => {
    const { service, runtime, lead, worker } = await setup([]);
    await service.send(lead, 'Plan');
    const item = service.getSnapshot().inbox![0]!;
    const originalStart = runtime.start.bind(runtime);
    vi.spyOn(runtime, 'start').mockImplementation((request, onEvent) => {
      if (!request.prompt.startsWith('Verify task:'))
        return originalStart(request, onEvent);
      runtime.requests.push(structuredClone(request));
      return { stop: vi.fn(async () => {}) };
    });
    const retrying = service.resolveInbox(item.id, 'retry');
    await vi.waitFor(() =>
      expect(service.getSnapshot().agents[item.agentId]!.status).not.toBe(
        'needs-you',
      ),
    );
    await vi.waitFor(() =>
      expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
        status: 'verifying',
        attempt: 4,
      }),
    );
    const queued = service.send(worker, 'Queued chat');
    await vi.waitFor(() => expect(service.getSnapshot().queue.queued).toBe(1));
    const before = runtime.requests.length;
    await service.stopAll();
    await Promise.all([retrying, queued]);
    expect(runtime.requests).toHaveLength(before);
    expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
      status: 'cancelled',
      attempt: 4,
    });
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
  });
  it.each(['accept', 'cancel', 'dismiss'] as const)(
    'persists %s resolution across reload without another runtime run',
    async (action) => {
      const { service, runtime, lead, options } = await setup([]);
      await service.send(lead, 'Plan');
      const item = service.getSnapshot().inbox![0]!;
      expect(item.kind).toBe('verification-exhausted');
      const before = runtime.requests.length;
      await service.resolveInbox(item.id, action);
      await service.resolveInbox(item.id, action);
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(fresh.getSnapshot().inbox![0]).toMatchObject({
        resolved: true,
        resolution: action,
      });
      expect(runtime.requests).toHaveLength(before);
      if (action !== 'dismiss')
        expect(fresh.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
          status: action === 'accept' ? 'passed' : 'cancelled',
        });
      expect(fresh.getSnapshot().agents[item.agentId]!.status).toBe('idle');
    },
  );
  it('reloads an exhausted task then retries exactly two additional attempts once under concurrent clicks', async () => {
    const { service, runtime, lead, options } = await setup([]);
    await service.send(lead, 'Plan');
    const original = service.getSnapshot().tasks![0]!.frontmatter as Record<
      string,
      unknown
    >;
    const fresh = new ChatService(options);
    await fresh.initialize();
    const item = fresh.getSnapshot().inbox![0]!;
    const before = runtime.requests.length;
    await Promise.all([
      fresh.resolveInbox(item.id, 'retry'),
      fresh.resolveInbox(item.id, 'retry'),
      fresh.resolveInbox(item.id, 'accept'),
    ]);
    const snapshot = fresh.getSnapshot();
    expect(snapshot.tasks![0]!.frontmatter).toMatchObject({
      status: 'needs-you',
      attempt: 5,
      maxAttempts: 5,
      sessionId: original.sessionId,
    });
    expect(snapshot.inbox!.filter((entry) => !entry.resolved)).toHaveLength(1);
    expect(snapshot.inbox!.find((entry) => entry.id === item.id)).toMatchObject(
      { resolved: true, resolution: 'retry' },
    );
    const workers = runtime.requests
      .slice(before)
      .filter((request) => request.prompt.startsWith('Verifier feedback:'));
    expect(workers).toHaveLength(2);
    expect(
      workers.every(
        (request) => request.resume && request.sessionId === original.sessionId,
      ),
    ).toBe(true);
  });
  it.each([
    'Nothing to report',
    '```agenthq-verdict\n{"verdict":"maybe","feedback":"?"}\n```',
    '```agenthq-verdict\n{"verdict":"pass","feedback":"ok"}\n```\nNot terminal',
  ])(
    'treats missing or invalid verdict as a failed attempt: %s',
    async (text) => {
      const { service, lead } = await setup([text, text, text]);
      await service.send(lead, 'Plan');
      expect(service.getSnapshot().tasks![0]!.frontmatter).toMatchObject({
        attempt: 3,
        verdict: 'fail',
        feedback: 'No valid verdict given',
        status: 'needs-you',
      });
      expect(service.getSnapshot().inbox![0]!.message).toBe(
        'No valid verdict given',
      );
    },
  );
  it('fails twice then passes on attempt three, resuming only the worker task session with feedback', async () => {
    const { service, store, runtime, lead, worker, reviewer } = await setup([
      verdict('fail', 'Fix first'),
      verdict('fail', 'Fix second'),
      verdict('pass', 'Looks good'),
    ]);
    await service.send(worker, 'Personal worker');
    await service.send(reviewer, 'Personal reviewer');
    const personal = service.getSnapshot().agents;
    await service.send(lead, 'Plan');
    const task = (await store.loadTasks())[0]!;
    expect(task.frontmatter).toMatchObject({
      status: 'passed',
      attempt: 3,
      verdict: 'pass',
    });
    const workers = runtime.requests.filter(
      (request) =>
        request.prompt === 'Build' ||
        request.prompt.startsWith('Verifier feedback:'),
    );
    expect(workers).toHaveLength(3);
    expect(workers.map((request) => request.resume)).toEqual([
      false,
      true,
      true,
    ]);
    expect(new Set(workers.map((request) => request.sessionId)).size).toBe(1);
    expect(workers[1]!.prompt).toContain('Fix first');
    expect(workers[2]!.prompt).toContain('Fix second');
    const verifiers = runtime.requests.filter((request) =>
      request.prompt.startsWith('Verify task:'),
    );
    expect(verifiers).toHaveLength(3);
    expect(verifiers[0]!.sessionId).not.toBe(workers[0]!.sessionId);
    expect(verifiers[0]!.sessionId).not.toBe(
      personal[reviewer]!.session!.sessionId,
    );
    expect(task.frontmatter).toMatchObject({
      sessionId: workers[0]!.sessionId,
      costUsd: 0.30000000000000004,
    });
    expect(task.body).toContain('## Attempt 3');
    expect(task.body).toContain('Fix first');
    expect(task.body).toContain('Looks good');
    expect(service.getSnapshot().agents[worker]!.messages).toEqual(
      personal[worker]!.messages,
    );
    expect(service.getSnapshot().agents[reviewer]!.messages).toEqual(
      personal[reviewer]!.messages,
    );
    expect(service.getSnapshot().inbox).toEqual([]);
  });
});
