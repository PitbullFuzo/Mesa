import { describe, expect, it, vi } from 'vitest';
import { ChatService, type ChatServiceOptions } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime, type FakeScripts } from '../src/core/runtimes/fake';

const delegate = (tasks: { to: string; task: string }[]) =>
  '```agenthq-delegate\n' + JSON.stringify({ tasks }) + '\n```';
const reply = (text: string) => [
  { type: 'done' as const, text, isError: false },
];
async function setup(scripts: FakeScripts, settings = {}) {
  const store = new MemoryStore();
  const lead = await store.createAgent('CEO');
  const coder = await store.createAgent('Coder');
  const reviewer = await store.createAgent('Reviewer');
  for (const id of [lead, coder, reviewer])
    await store.patchAgent(id, { runtime: 'fake' });
  await store.setManager(coder, lead);
  await store.setManager(reviewer, lead);
  const runtime = new FakeRuntime(scripts, 0);
  const options: ChatServiceOptions = {
    store,
    adapters: [runtime],
    settings: () => ({
      maxParallelRuns: 1,
      allowedFolders: ['Obi-I/Work'],
      ...settings,
    }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
  };
  const service = new ChatService(options);
  await service.initialize();
  return { service, store, runtime, lead, coder, reviewer, options };
}

describe('delegation through ChatService', () => {
  it('applies one request run budget to all recipients of a broadcast', async () => {
    const { service, runtime } = await setup(() => reply('Finished'), {
      maxRunsPerRequest: 2,
    });
    await service.broadcast({ kind: 'everyone' }, 'Plan');
    expect(runtime.requests).toHaveLength(2);
    expect(service.getSnapshot().inbox).toHaveLength(1);
    expect(
      service
        .getSnapshot()
        .broadcast!.recipients.some(
          (recipient) => recipient.status === 'cancelled',
        ),
    ).toBe(true);
  });
  it('serializes inbox persistence so concurrent failed requests cannot overwrite each other', async () => {
    const invalid = delegate([{ to: 'Stranger', task: 'Invalid' }]);
    const { service, lead, coder, options } = await setup(
      () => reply(invalid),
      { maxParallelRuns: 2 },
    );
    let saved: unknown[] = [];
    options.saveInbox = async (items) => {
      if (items.length === 1)
        await new Promise((resolve) => setTimeout(resolve, 30));
      saved = structuredClone(items);
    };
    await Promise.all([
      service.send(lead, 'Plan'),
      service.send(coder, 'Plan'),
    ]);
    expect(saved).toHaveLength(2);
  });
  it('shares the queue with personal chat and persists queued tasks before they actually start', async () => {
    const { service, store, runtime, lead, coder, reviewer } = await setup(
      (request) =>
        request.prompt === 'Plan'
          ? reply(
              delegate([
                { to: 'Coder', task: 'Build' },
                { to: 'Reviewer', task: 'Inspect' },
              ]),
            )
          : request.prompt === 'Build'
            ? [
                ...Array.from({ length: 200 }, () => ({
                  type: 'text' as const,
                  text: '.',
                })),
                ...reply('Built'),
              ]
            : reply('Finished'),
    );
    const sending = service.send(lead, 'Plan');
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(2));
    const queued = (await store.loadTasks()).find(
      (note) => (note.frontmatter as Record<string, unknown>).toId === reviewer,
    )!;
    expect(queued.frontmatter).toMatchObject({ status: 'queued', attempt: 0 });
    expect(service.getSnapshot().agents[coder]!.status).toBe('working');
    await sending;
  });
  it('orders monthly activity appends, preserves existing content, and reloads task records', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 0, 31, 23, 58));
      const { service, store, lead, options } = await setup(
        (request) =>
          reply(
            request.prompt === 'Plan'
              ? delegate([
                  { to: 'Coder', task: 'Build' },
                  { to: 'Reviewer', task: 'Inspect' },
                ])
              : 'Finished',
          ),
        { maxParallelRuns: 2 },
      );
      await store.saveNote(
        'Obi-I/Activity/2026-01.md',
        { agenthq: 'activity', custom: true },
        'Earlier entry\n',
      );
      await service.send(lead, 'Plan');
      const january = (await store.loadActivity())[0]!;
      expect(january.body.split('\n').filter(Boolean)).toHaveLength(5);
      expect(january.body.startsWith('Earlier entry\n')).toBe(true);
      expect(january.frontmatter).toMatchObject({ custom: true });
      vi.setSystemTime(new Date(2026, 1, 1, 0, 1));
      await service.send(lead, 'Plan');
      const months = await store.loadActivity();
      expect(months.map((note) => note.path).sort()).toEqual([
        'Obi-I/Activity/2026-01.md',
        'Obi-I/Activity/2026-02.md',
      ]);
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(fresh.getSnapshot().tasks).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows worker queued/working status while keeping task attempts separate from nested turns', async () => {
    const { service, runtime, lead, coder } = await setup((request) =>
      reply(
        request.prompt === 'Plan'
          ? delegate([{ to: 'Coder', task: 'Build' }])
          : 'Finished',
      ),
    );
    const statuses: string[] = [];
    service.subscribe((snapshot) => {
      statuses.push(snapshot.agents[coder]!.status);
    });
    await service.send(lead, 'Plan');
    expect(statuses).toContain('queued');
    expect(statuses).toContain('working');
    expect(service.getSnapshot().agents[coder]!.status).toBe('idle');
    expect(runtime.requests).toHaveLength(3);
  });
  it('does not increment task attempt for intermediate results turns', async () => {
    const { service, store, lead, coder, reviewer } = await setup((request) =>
      reply(
        request.prompt === 'Plan'
          ? delegate([{ to: 'Coder', task: 'Build' }])
          : request.prompt === 'Build'
            ? delegate([{ to: 'Reviewer', task: 'Nested' }])
            : 'Finished',
      ),
    );
    await store.setManager(reviewer, coder);
    await service.refreshRuntimes();
    await service.send(lead, 'Plan');
    const task = (await store.loadTasks())[0]!;
    expect(task.body).not.toContain('## Attempt 2');
    expect(task.body).toContain('Finished');
  });
  it('delegates from broadcasts and recovers the queued results turn using the existing session retry', async () => {
    let resultCalls = 0;
    const { service, runtime, lead } = await setup((request) =>
      request.prompt === 'Plan'
        ? reply(delegate([{ to: 'Coder', task: 'Build' }]))
        : request.prompt.startsWith('Results from your team:')
          ? ++resultCalls === 1
            ? [{ type: 'done', text: 'No conversation found', isError: true }]
            : reply('Recovered')
          : reply('Built'),
    );
    await service.broadcast({ kind: 'agent', id: lead }, 'Plan');
    expect(runtime.requests).toHaveLength(4);
    expect(runtime.requests[2]!.resume).toBe(true);
    expect(runtime.requests[3]!.resume).toBe(false);
    expect(runtime.requests[3]!.sessionId).not.toBe(
      runtime.requests[2]!.sessionId,
    );
    expect(service.getSnapshot().broadcast!.recipients[0]!.status).toBe(
      'replied',
    );
  });
  it('counts recovery attempts against the request run limit', async () => {
    const { service, runtime, lead } = await setup(
      (request) =>
        request.prompt === 'Plan'
          ? reply(delegate([{ to: 'Coder', task: 'Build' }]))
          : request.prompt.startsWith('Results from your team:')
            ? [{ type: 'done', text: 'No conversation found', isError: true }]
            : reply('Built'),
      { maxRunsPerRequest: 3 },
    );
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(3);
    expect(service.getSnapshot().inbox![0]!.kind).toBe('run-limit');
    expect(service.getSnapshot().agents[lead]!.status).toBe('needs-you');
  });
  it('developer fake demo is opt-in, delegates to the named reports, then terminates', async () => {
    const { service, store, runtime, lead } = await setup([]);
    await service.send(lead, 'Developer delegation demo');
    expect(await store.loadTasks()).toHaveLength(2);
    expect(runtime.requests).toHaveLength(4);
    expect(runtime.requests[3]!.prompt).toContain('Results from your team:');
    await service.send(lead, 'Ordinary message');
    expect(runtime.requests).toHaveLength(5);
  });
  it.each([{ maxDelegationDepth: 1 }, { maxRunsPerRequest: 2 }])(
    'stops the whole nested request at its limit: %j',
    async (limits) => {
      const { service, store, runtime, lead, coder, reviewer } = await setup(
        (request) =>
          reply(
            request.prompt === 'Plan'
              ? delegate([{ to: 'Coder', task: 'Build' }])
              : request.prompt === 'Build'
                ? delegate([{ to: 'Reviewer', task: 'Nested' }])
                : 'Finished',
          ),
        limits,
      );
      await store.setManager(reviewer, coder);
      await service.refreshRuntimes();
      await service.send(lead, 'Plan');
      expect(runtime.requests).toHaveLength(2);
      expect(service.getSnapshot().inbox).toHaveLength(1);
      expect(service.getSnapshot().inbox![0]!.kind).toBe(
        'maxDelegationDepth' in limits ? 'depth-limit' : 'run-limit',
      );
      expect(
        (await store.loadTasks()).every(
          (note) =>
            (note.frontmatter as Record<string, unknown>).status !== 'passed',
        ),
      ).toBe(true);
      expect(
        runtime.requests.some((request) =>
          request.prompt.startsWith('Results from your team:'),
        ),
      ).toBe(false);
    },
  );
  it('allows nested delegation and resumes the intermediate task session for its results', async () => {
    const { service, store, runtime, lead, coder, reviewer } = await setup(
      (request) =>
        reply(
          request.prompt === 'Plan'
            ? delegate([{ to: 'Coder', task: 'Build' }])
            : request.prompt === 'Build'
              ? delegate([{ to: 'Reviewer', task: 'Nested' }])
              : 'Finished',
        ),
    );
    await store.setManager(reviewer, coder);
    await service.refreshRuntimes();
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(5);
    expect(runtime.requests[3]).toMatchObject({
      sessionId: runtime.requests[1]!.sessionId,
      resume: true,
    });
    const tasks = await store.loadTasks();
    expect(
      tasks.map((note) => (note.frontmatter as Record<string, unknown>).depth),
    ).toEqual([1, 2]);
    expect(
      tasks.every(
        (note) =>
          (note.frontmatter as Record<string, unknown>).status === 'passed',
      ),
    ).toBe(true);
  });
  it('Stop on a delegating lead cancels its running worker and prevents results or sibling follow-ups', async () => {
    const { service, runtime, store, lead } = await setup((request) =>
      request.prompt === 'Plan'
        ? reply(
            delegate([
              { to: 'Coder', task: 'Build' },
              { to: 'Reviewer', task: 'Inspect' },
            ]),
          )
        : Array.from({ length: 1000 }, () => ({
            type: 'text' as const,
            text: 'working',
          })),
    );
    const sending = service.send(lead, 'Plan');
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(2));
    // Pause worker scripts instead of consuming paid inference.
    await service.stop(lead);
    await sending;
    expect(
      runtime.requests.some((request) =>
        request.prompt.startsWith('Results from your team:'),
      ),
    ).toBe(false);
    expect(
      (await store.loadTasks()).every(
        (note) =>
          (note.frontmatter as Record<string, unknown>).status === 'cancelled',
      ),
    ).toBe(true);
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
  });
  it('corrects a non-report once, then persists an inbox item and reloads it', async () => {
    const invalid = delegate([{ to: 'Stranger', task: 'Do work' }]);
    const { service, runtime, store, lead, options } = await setup(() =>
      reply(invalid),
    );
    let inbox: unknown[] = [];
    options.loadInbox = async () => inbox;
    options.saveInbox = async (items) => {
      inbox = structuredClone(items);
    };
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]!.prompt).toContain('Correction');
    expect(runtime.requests[1]!.resume).toBe(true);
    expect(await store.loadTasks()).toHaveLength(0);
    expect(service.getSnapshot().inbox).toHaveLength(1);
    expect(inbox).toHaveLength(1);
    const reloaded = new ChatService(options);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().inbox).toEqual(inbox);
    expect(service.getSnapshot().agents[lead]!.status).toBe('needs-you');
  });
  it('runs two dedicated task sessions and returns one queued results turn with task links, preserving worker chat', async () => {
    const { service, store, runtime, lead, coder } = await setup((request) =>
      reply(
        request.prompt === 'Plan'
          ? delegate([
              { to: 'Coder', task: 'Build' },
              { to: 'Reviewer', task: 'Inspect' },
            ])
          : request.prompt.startsWith('Results from your team:')
            ? 'All done'
            : 'Answer: ' + request.prompt,
      ),
    );
    await service.send(coder, 'Personal chat');
    const personal = service.getSnapshot().agents[coder]!.session!.sessionId;
    await service.send(lead, 'Plan');
    expect(runtime.requests).toHaveLength(5);
    const results = runtime.requests.filter((request) =>
      request.prompt.startsWith('Results from your team:'),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      resume: true,
      sessionId: runtime.requests[1]!.sessionId,
    });
    expect(results[0]!.prompt).toContain('Answer: Build');
    expect(results[0]!.prompt).toContain('Answer: Inspect');
    const tasks = await store.loadTasks();
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(results[0]!.prompt).toContain(
        `[[${task.path.replace(/\.md$/, '')}]]`,
      );
      expect(task.frontmatter).toMatchObject({
        agenthq: 'task',
        status: 'passed',
        attempt: 1,
        depth: 1,
      });
      expect((task.frontmatter as Record<string, unknown>).sessionId).not.toBe(
        personal,
      );
      expect(task.body).toContain('## Attempt 1');
    }
    expect(service.getSnapshot().agents[coder]!.session!.sessionId).toBe(
      personal,
    );
    expect(service.getSnapshot().agents[coder]!.messages).toHaveLength(2);
    expect(
      (await store.loadChats()).filter(
        (note) =>
          (note.frontmatter as Record<string, unknown>).agentId === coder,
      ),
    ).toHaveLength(1);
    const activity = await store.loadActivity();
    expect(activity).toHaveLength(1);
    const lines = activity[0]!.body.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(
      /^- \d\d:\d\d \[\[.*CEO.*\]\] delegated \[\[.*\]\] to \[\[.*Coder.*\]\]$/,
    );
    expect(lines[1]).toContain('Reviewer');
    expect(lines.filter((line) => line.includes('completed'))).toHaveLength(2);
    expect(service.getSnapshot().tasks).toHaveLength(2);
  });
});
