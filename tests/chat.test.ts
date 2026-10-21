import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '../src/core/runtimes/types';

class ControlledRuntime implements RuntimeAdapter {
  id = 'fake' as const;
  displayName = 'Test runtime';
  requests: RunRequest[] = [];
  callbacks: ((event: RunEvent) => void)[] = [];
  stops = 0;
  async detect() {
    return { available: true };
  }
  start(request: RunRequest, callback: (event: RunEvent) => void) {
    this.requests.push(request);
    this.callbacks.push(callback);
    return {
      stop: async () => {
        this.stops++;
      },
    };
  }
  emit(event: RunEvent, index = this.callbacks.length - 1) {
    this.callbacks[index]!(event);
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup() {
  const store = new MemoryStore();
  const id = await store.createAgent('Coder');
  await store.patchAgent(id, { runtime: 'fake', instructions: 'Be concise.' });
  const runtime = new ControlledRuntime();
  const saves = vi.spyOn(store, 'saveNote');
  const options = {
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    agentLink: async () => '[[Coder]]',
  };
  const service = new ChatService(options);
  await service.initialize();
  return { store, id, runtime, saves, options, service };
}

describe('ChatService', () => {
  it('resumes an initialized first session after a model error, including after reload', async () => {
    const { id, service, runtime, options } = await setup();
    const first = service.send(id, 'hi');
    await tick();
    const sessionId = runtime.requests[0]!.sessionId;
    runtime.emit({ type: 'session', sessionId });
    runtime.emit({ type: 'done', text: 'Invalid model', isError: true });
    await first;
    expect(service.getSnapshot().agents[id]!.session!.hasRun).toBe(true);
    const fresh = new ChatService(options);
    await fresh.initialize();
    const next = fresh.send(id, 'hi');
    await tick();
    expect(runtime.requests[1]).toMatchObject({ sessionId, resume: true });
    runtime.emit({ type: 'done', text: 'Hello', isError: false });
    await next;
    expect(runtime.requests).toHaveLength(2);
  });
  it.each([false, true])(
    'retries an already-in-use session once with resume (retry fails: %s)',
    async (retryFails) => {
      const { id, service, runtime, options } = await setup();
      const first = service.send(id, 'bad model');
      await tick();
      runtime.emit({ type: 'done', text: 'Invalid model', isError: true });
      await first;
      const sessionId = runtime.requests[0]!.sessionId;
      const next = service.send(id, 'hi');
      await tick();
      expect(runtime.requests[1]).toMatchObject({ sessionId, resume: false });
      runtime.emit({
        type: 'done',
        text: `Error: Session ID ${sessionId} is already in use.`,
        isError: true,
      });
      await tick();
      const retried = runtime.requests[2];
      if (retried)
        runtime.emit({
          type: 'done',
          text: retryFails ? 'No conversation found' : 'Hello',
          isError: retryFails,
        });
      await next;
      expect(retried).toMatchObject({ sessionId, resume: true, prompt: 'hi' });
      expect(runtime.requests).toHaveLength(3);
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(fresh.getSnapshot().agents[id]!.session).toMatchObject({
        sessionId,
        hasRun: true,
      });
    },
  );
  it('rejects full permission before queueing, creating a session or calling the runtime', async () => {
    const { id, service, runtime, store } = await setup();
    await store.patchAgent(id, { permission: 'full' });
    await service.refreshRuntimes();
    const queued = vi.fn();
    service.subscribe((snapshot) => {
      if (snapshot.agents[id]!.status === 'queued') queued();
    });
    const outcome = service.send(id, 'hello').catch((error: unknown) => error);
    await tick();
    if (runtime.requests.length)
      runtime.emit({ type: 'done', text: 'refused', isError: true });
    expect(await outcome).toEqual(
      new Error('Full permission is not available — choose edit or read-only'),
    );
    expect(runtime.requests).toHaveLength(0);
    expect(queued).not.toHaveBeenCalled();
    expect(service.getSnapshot().agents[id]!.session).toBeNull();
    expect(await store.loadChats()).toHaveLength(0);
  });
  it.each(['refused', 'cancelled'] as const)(
    'does not mark a %s first run resumable, including after reload',
    async (outcome) => {
      const { id, service, runtime, options } = await setup();
      const sent = service.send(id, 'hello');
      await tick();
      if (outcome === 'refused')
        runtime.emit({ type: 'done', text: 'Run refused', isError: true });
      else await service.stop(id);
      await sent;
      expect(service.getSnapshot().agents[id]!.session!.hasRun).toBe(false);
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(fresh.getSnapshot().agents[id]!.session!.hasRun).toBe(false);
      const retry = fresh.send(id, 'retry');
      await tick();
      expect(runtime.requests[1]!.resume).toBe(false);
      runtime.emit({ type: 'done', text: 'ok', isError: false });
      await retry;
      expect(fresh.getSnapshot().agents[id]!.session!.hasRun).toBe(true);
    },
  );
  it.each([false, true])(
    'recovers a missing resumed session once without old context (retry fails: %s)',
    async (retryFails) => {
      const { id, service, runtime, store, options } = await setup();
      const first = service.send(id, 'old message');
      await tick();
      runtime.emit({ type: 'done', text: 'old answer', isError: false });
      await first;
      const old = (await store.loadChats())[0]!;
      await store.saveNote(
        old.path,
        {
          ...(old.frontmatter as Record<string, unknown>),
          carrySummary: 'stale summary',
        },
        old.body,
      );
      const fresh = new ChatService(options);
      await fresh.initialize();
      const next = fresh.send(id, 'current message');
      await tick();
      expect(runtime.requests[1]!.resume).toBe(true);
      runtime.emit({
        type: 'done',
        text: 'No conversation found with session ID old',
        isError: true,
        errorKind: 'other',
      });
      await tick();
      expect(runtime.requests).toHaveLength(3);
      expect(runtime.requests[2]).toMatchObject({
        resume: false,
        prompt: 'current message',
        previousCostUsd: 0,
      });
      expect(runtime.requests[2]!.sessionId).not.toBe(
        runtime.requests[1]!.sessionId,
      );
      runtime.emit({
        type: 'done',
        text: retryFails
          ? 'No conversation found with session ID new'
          : 'recovered',
        isError: retryFails,
      });
      await next;
      expect(runtime.requests).toHaveLength(3);
      const archived = (await store.loadChats()).find(
        (note) => note.path === old.path,
      )!;
      expect(archived.frontmatter).toMatchObject({ closed: true, summary: '' });
      expect(archived.body).toContain('old answer');
      const state = fresh.getSnapshot().agents[id]!;
      expect(state.session).toMatchObject({
        carrySummary: '',
        hasRun: !retryFails,
      });
      expect(state.messages.map((message) => message.content)).toEqual([
        'current message',
        retryFails ? 'No conversation found with session ID new' : 'recovered',
      ]);
    },
  );
  it.each(['stop', 'dispose'] as const)(
    'does not replace the session when %s cancels a failed summary during archival',
    async (action) => {
      const { id, service, runtime, store } = await setup();
      const first = service.send(id, 'hello');
      await tick();
      runtime.emit({ type: 'done', text: 'answer', isError: false });
      await first;
      const old = service.getSnapshot().agents[id]!.session!;
      const save = MemoryStore.prototype.saveNote.bind(store);
      let release!: () => void;
      vi.spyOn(store, 'saveNote').mockImplementation(async (path, fm, body) => {
        if (fm.closed)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        await save(path, fm, body);
      });
      const closing = service.newConversation(id);
      await tick();
      runtime.emit({ type: 'done', text: 'summary failed', isError: true });
      await tick();
      const stopped = action === 'stop' ? service.stop(id) : service.dispose();
      release();
      await Promise.all([closing, stopped]);
      expect(service.getSnapshot().agents[id]!.session!.sessionId).toBe(
        old.sessionId,
      );
      expect(await store.loadChats()).toHaveLength(1);
      expect(runtime.requests).toHaveLength(2);
    },
  );
  it.each(['stop', 'dispose'] as const)(
    'does not retry a missing resume when %s overtakes runtime cleanup',
    async (action) => {
      const { id, service, runtime } = await setup();
      const first = service.send(id, 'old');
      await tick();
      runtime.emit({ type: 'done', text: 'answer', isError: false });
      await first;
      const sessionId = service.getSnapshot().agents[id]!.session!.sessionId;
      const original = runtime.start.bind(runtime);
      let release!: () => void;
      vi.spyOn(runtime, 'start').mockImplementationOnce((request, callback) => {
        const handle = original(request, callback);
        return {
          stop: async () => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            await handle.stop();
          },
        };
      });
      const next = service.send(id, 'current');
      await tick();
      runtime.emit({
        type: 'done',
        text: 'No conversation found',
        isError: true,
      });
      await tick();
      const stopped = action === 'stop' ? service.stop(id) : service.dispose();
      release();
      await Promise.all([next, stopped]);
      expect(runtime.requests).toHaveLength(2);
      expect(service.getSnapshot().agents[id]!.session!.sessionId).toBe(
        sessionId,
      );
    },
  );
  it('uses readable local filenames and headings without losing exact session or message metadata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const started = new Date(2026, 9, 15, 8, 27, 52, 200);
    vi.setSystemTime(started);
    try {
      const { id, service, runtime, store, options } = await setup();
      const sent = service.send(id, 'Plan the next release please');
      await tick();
      runtime.emit({ type: 'done', text: 'A plan.', isError: false });
      await sent;
      const note = (await store.loadChats())[0]!;
      expect(note.path).toBe(
        'Obi-I/Chats/Plan the next release please — Coder — 2026-10-15 0827.md',
      );
      expect(note.body).toContain('### You · 08:27\n');
      expect(note.body).toContain('### Coder · 08:27\n');
      expect(note.frontmatter).toMatchObject({
        agentId: id,
        sessionId: runtime.requests[0]!.sessionId,
        started: started.toISOString(),
      });
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(
        fresh
          .getSnapshot()
          .agents[id]!.messages.map((message) => message.timestamp),
      ).toEqual([started.toISOString(), started.toISOString()]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('suffixes colliding readable names without overwriting existing notes or changing paths on follow-up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 8, 27));
    try {
      const { id, service, runtime, store } = await setup();
      const base = 'Obi-I/Chats/Same request — Coder — 2026-10-15 0827';
      await store.createNote(`${base}.md`, { keep: true }, 'Existing note');
      await store.createFolder(`${base} (2).md`);
      const sent = service.send(id, 'Same request');
      await tick();
      runtime.emit({ type: 'done', text: 'Answer', isError: false });
      await sent;
      expect(service.getSnapshot().agents[id]!.session!.path).toBe(
        `${base} (3).md`,
      );
      expect(store.notes.get(`${base}.md`)!.body).toBe('Existing note');
      const followup = service.send(id, 'Different words');
      await tick();
      runtime.emit({ type: 'done', text: 'Again', isError: false });
      await followup;
      expect(service.getSnapshot().agents[id]!.session!.path).toBe(
        `${base} (3).md`,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('names a replacement conversation from its first user message even after reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 8, 27));
    try {
      const { id, service, runtime, store, options } = await setup();
      await service.newConversation(id);
      const oldPath = service.getSnapshot().agents[id]!.session!.path;
      const fresh = new ChatService(options);
      await fresh.initialize();
      const sessionId = fresh.getSnapshot().agents[id]!.session!.sessionId;
      const sent = fresh.send(id, 'Next / task: [build] #one?');
      await tick();
      runtime.emit({ type: 'done', text: 'Ready', isError: false });
      await sent;
      const notes = await store.loadChats();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.path).toBe(
        'Obi-I/Chats/Next task build one — Coder — 2026-10-15 0827.md',
      );
      expect(await store.exists(oldPath)).toBe(false);
      expect(notes[0]!.frontmatter).toMatchObject({ sessionId });
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not resume legacy sessions whose runtime identity was not recorded', async () => {
    const { id, service, runtime, store, options } = await setup();
    const first = service.send(id, 'one');
    await tick();
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await first;
    const note = (await store.loadChats())[0]!;
    const fm = { ...(note.frontmatter as Record<string, unknown>) };
    delete fm.runtimeId;
    await store.saveNote(note.path, fm, note.body);
    const fresh = new ChatService(options);
    await fresh.initialize();
    const next = fresh.send(id, 'two');
    await tick();
    expect(runtime.requests[1]!.resume).toBe(false);
    runtime.emit({ type: 'done', text: 'two', isError: false });
    await next;
    expect(await store.loadChats()).toHaveLength(2);
  });
  it('pins a preparing run to its selected runtime and permissions', async () => {
    const { id, runtime, store, options } = await setup();
    let release!: () => void;
    const service = new ChatService({
      ...options,
      prepareDirectory: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await service.initialize();
    const sent = service.send(id, 'one');
    await tick();
    await store.patchAgent(id, { runtime: 'codex', permission: 'full' });
    await service.refreshRuntimes();
    release();
    await tick();
    expect(service.getSnapshot().agents[id]!.session!.runtimeId).toBe('fake');
    expect(runtime.requests[0]!.permission).toBe('read-only');
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await sent;
  });
  it('passes the persisted cumulative cost baseline to resumed messages and summaries', async () => {
    const { id, service, runtime, options } = await setup();
    const first = service.send(id, 'one');
    await tick();
    expect(runtime.requests[0]).toMatchObject({ previousCostUsd: 0 });
    runtime.emit({ type: 'done', text: 'one', costUsd: 0.03, isError: false });
    await first;
    const fresh = new ChatService(options);
    await fresh.initialize();
    const second = fresh.send(id, 'two');
    await tick();
    expect(runtime.requests[1]).toMatchObject({ previousCostUsd: 0.03 });
    runtime.emit({ type: 'done', text: 'two', costUsd: 0.02, isError: false });
    await second;
    const closing = fresh.newConversation(id);
    await tick();
    expect(runtime.requests[2]).toMatchObject({ previousCostUsd: 0.05 });
    runtime.emit({
      type: 'done',
      text: 'Summary',
      costUsd: 0.01,
      isError: false,
    });
    await closing;
  });
  it('closes a switched-runtime conversation without resuming its incompatible session', async () => {
    const { id, service, runtime, store } = await setup();
    const first = service.send(id, 'one');
    await tick();
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await first;
    await store.patchAgent(id, { runtime: 'codex' });
    await service.refreshRuntimes();
    await service.newConversation(id);
    expect(runtime.requests).toHaveLength(1);
    expect(service.getSnapshot().agents[id]!.session).toMatchObject({
      runtimeId: 'codex',
      hasRun: false,
    });
    expect(await store.loadChats()).toHaveLength(2);
  });
  it('isolates a queued message from a previous runtime session after switching', async () => {
    const { id, runtime, store, options } = await setup();
    const other = new ControlledRuntime();
    const service = new ChatService({
      ...options,
      adapters: [
        runtime,
        {
          id: 'codex',
          displayName: 'Second fake',
          detect: other.detect.bind(other),
          start: other.start.bind(other),
        },
      ],
    });
    await service.initialize();
    const first = service.send(id, 'one');
    await tick();
    const queued = service.send(id, 'two');
    await store.patchAgent(id, { runtime: 'codex' });
    await service.refreshRuntimes();
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await first;
    await tick();
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.resume).toBe(false);
    expect(other.requests[0]!.sessionId).not.toBe(
      runtime.requests[0]!.sessionId,
    );
    other.emit({ type: 'done', text: 'two', isError: false });
    await queued;
    expect((await store.loadChats()).map((note) => note.frontmatter)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runtimeId: 'fake', closed: true }),
        expect.objectContaining({ runtimeId: 'codex' }),
      ]),
    );
  });
  it('ignores runtime detection completed by a superseded refresh', async () => {
    const { service, runtime } = await setup();
    let release!: () => void;
    vi.spyOn(runtime, 'detect').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ available: false });
        }),
    );
    const stale = service.refreshRuntimes();
    await tick();
    await service.refreshRuntimes();
    release();
    await stale;
    expect(service.getSnapshot().runtimes.fake!.available).toBe(true);
  });
  it('ignores a stale refresh read after a newer refresh completed', async () => {
    const { id, service, store } = await setup();
    const oldAgents = await store.loadAgents();
    let release!: () => void;
    vi.spyOn(store, 'loadAgents').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(oldAgents);
        }),
    );
    const oldRefresh = service.refreshRuntimes();
    await store.patchAgent(id, { instructions: 'Latest' });
    await service.refreshRuntimes();
    release();
    await oldRefresh;
    expect(service.getSnapshot().agents[id]!.agent.instructions).toBe('Latest');
  });
  it('keeps sign-in guidance across automatic refreshes', async () => {
    const { id, service, runtime } = await setup();
    const sent = service.send(id, 'hello');
    await tick();
    runtime.emit({
      type: 'done',
      text: 'Sign in',
      isError: true,
      errorKind: 'auth',
    });
    await sent;
    await service.refreshRuntimes();
    expect(service.getSnapshot().agents[id]!.status).toBe('needs-you');
    expect(service.getSnapshot().agents[id]!.hint).toContain('sign in');
  });
  it('recovers the last closed summary if creating the replacement note failed', async () => {
    const { id, service, runtime, store, options } = await setup();
    const first = service.send(id, 'remember pears');
    await tick();
    runtime.emit({ type: 'done', text: 'Remembered', isError: false });
    await first;
    const save = MemoryStore.prototype.saveNote.bind(store);
    vi.spyOn(store, 'saveNote').mockImplementation(async (path, fm, body) => {
      if (fm.hasRun === false) throw new Error('disk full');
      await save(path, fm, body);
    });
    const closing = service.newConversation(id);
    const failed = expect(closing).rejects.toThrow('disk full');
    await tick();
    runtime.emit({ type: 'done', text: 'Pears matter', isError: false });
    await failed;
    const fresh = new ChatService(options);
    await fresh.initialize();
    expect(fresh.getSnapshot().agents[id]!.session).toMatchObject({
      hasRun: false,
      carrySummary: 'Pears matter',
    });
  });
  it('does not start a runtime if a status subscriber stops the run', async () => {
    const { id, service, runtime } = await setup();
    let stopped: Promise<void> | undefined;
    service.subscribe((snapshot) => {
      if (snapshot.agents[id]!.status === 'working' && !stopped)
        stopped = service.stop(id);
    });
    await service.send(id, 'hello');
    await stopped;
    expect(runtime.requests).toHaveLength(0);
    expect(service.getSnapshot().agents[id]!.session!.hasRun).toBe(false);
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
  });
  it('keeps working status when the next same-agent message starts', async () => {
    const { id, service, runtime } = await setup();
    const first = service.send(id, 'one');
    await tick();
    const second = service.send(id, 'two');
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await first;
    await tick();
    expect(runtime.requests).toHaveLength(2);
    expect(service.getSnapshot().agents[id]!.status).toBe('working');
    runtime.emit({ type: 'done', text: 'two', isError: false });
    await second;
  });
  it('finalizes a failed start so the transcript can recover and reload', async () => {
    const { id, service, runtime, options } = await setup();
    vi.spyOn(runtime, 'start').mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(service.send(id, 'first')).rejects.toThrow('spawn failed');
    expect(service.getSnapshot().agents[id]!.messages.at(-1)).toMatchObject({
      streaming: false,
      cancelled: true,
    });
    const next = service.send(id, 'retry');
    await tick();
    expect(runtime.requests[0]!.resume).toBe(false);
    runtime.emit({ type: 'done', text: 'Recovered', isError: false });
    await next;
    const fresh = new ChatService(options);
    await fresh.initialize();
    expect(fresh.getSnapshot().agents[id]!.messages).toHaveLength(4);
  });
  it('keeps transcript text only in the body and restores heading-like content, tools and costs', async () => {
    const { id, service, runtime, store, options } = await setup();
    const content =
      'Text\n\n### You · 2026-01-01T00:00:00Z\n\nNot another message.';
    const sent = service.send(id, content);
    await tick();
    runtime.emit({
      type: 'tool',
      name: 'Read',
      summary: 'Line one\nLine two -->',
    });
    runtime.emit({
      type: 'done',
      text: content,
      costUsd: 0.03,
      isError: false,
    });
    await sent;
    const note = (await store.loadChats())[0]!;
    expect(note.frontmatter).not.toHaveProperty('messages');
    const fresh = new ChatService(options);
    await fresh.initialize();
    expect(fresh.getSnapshot().agents[id]!.messages).toHaveLength(2);
    expect(fresh.getSnapshot().agents[id]!.messages[1]).toMatchObject({
      content,
      costUsd: 0.03,
      tools: [{ name: 'Read', summary: 'Line one\nLine two -->' }],
    });
  });
  it('limits five actual fake-runtime messages to two concurrent runs', async () => {
    const store = new MemoryStore();
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const id = await store.createAgent(`Agent ${index}`);
      await store.patchAgent(id, { runtime: 'fake' });
      ids.push(id);
    }
    const runtime = new FakeRuntime([], 5);
    let active = 0;
    let peak = 0;
    const start = runtime.start.bind(runtime);
    vi.spyOn(runtime, 'start').mockImplementation((request, callback) => {
      peak = Math.max(peak, ++active);
      const handle = start(request, callback);
      return {
        stop: async () => {
          await handle.stop();
          active--;
        },
      };
    });
    const service = new ChatService({
      store,
      adapters: [runtime],
      settings: () => ({
        maxParallelRuns: 2,
        allowedFolders: ['Obi-I/Work'],
      }),
      vaultBasePath: '/vault',
      managedRoot: 'Obi-I',
    });
    await service.initialize();
    await Promise.all(ids.map((id) => service.send(id, 'Hello')));
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(runtime.requests).toHaveLength(5);
    expect(await store.loadChats()).toHaveLength(5);
  });
  it('does not start a summary after stopAll overtakes newConversation before enqueue', async () => {
    const { id, service, runtime } = await setup();
    const sent = service.send(id, 'hello');
    await tick();
    runtime.emit({ type: 'done', text: 'hello', isError: false });
    await sent;
    const closing = service.newConversation(id);
    await service.stopAll();
    await tick();
    expect(runtime.requests).toHaveLength(1);
    await closing;
  });
  it('waits for delayed runtime cleanup and prevents late streaming after completion', async () => {
    const { id, service, runtime } = await setup();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = runtime.start.bind(runtime);
    vi.spyOn(runtime, 'start').mockImplementation((request, callback) => {
      const handle = original(request, callback);
      return {
        stop: async () => {
          await cleanup;
          await handle.stop();
        },
      };
    });
    const sent = service.send(id, 'hello');
    await tick();
    runtime.emit({ type: 'done', text: 'Final', isError: false });
    await tick();
    runtime.emit({ type: 'text', text: 'late' });
    expect(service.getSnapshot().agents[id]!.messages.at(-1)!.content).toBe('');
    let stopped = false;
    const stop = service.stop(id).then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    release();
    await Promise.all([sent, stop]);
    expect(service.getSnapshot().agents[id]!.messages.at(-1)!.content).toBe(
      'Final',
    );
  });
  it('stops during skill loading without leaving a streaming placeholder or starting a run', async () => {
    const { id, service, runtime, store } = await setup();
    let release!: () => void;
    const skills = new Promise<[]>((resolve) => {
      release = () => resolve([]);
    });
    vi.spyOn(store, 'loadSkills').mockReturnValue(skills);
    const sent = service.send(id, 'hello');
    await tick();
    const stop = service.stop(id);
    release();
    await Promise.all([stop, sent]);
    expect(runtime.requests).toHaveLength(0);
    expect(
      service
        .getSnapshot()
        .agents[id]!.messages.some((message) => message.streaming),
    ).toBe(false);
  });
  it('continues safely when a subscriber throws', async () => {
    const { id, service, runtime } = await setup();
    service.subscribe(() => {
      throw new Error('view failure');
    });
    const sent = service.send(id, 'hello');
    // Attach immediately: a view must not reject the request or leak its runtime.
    const finished = expect(sent).resolves.toBeUndefined();
    await tick();
    runtime.emit({ type: 'done', text: 'ok', isError: false });
    await finished;
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
  });
  it('refuses unsafe workdirs before preparing folders or starting a runtime', async () => {
    const { id, service, runtime, options, store } = await setup();
    await store.patchAgent(id, { workdir: '../outside' });
    const prepareDirectory = vi.fn(async () => {});
    const fresh = new ChatService({ ...options, prepareDirectory });
    await fresh.initialize();
    await expect(fresh.send(id, 'unsafe')).rejects.toThrow('allowed');
    expect(prepareDirectory).not.toHaveBeenCalled();
    expect(runtime.requests).toHaveLength(0);
    expect(fresh.getSnapshot().agents[id]!.status).toBe('error');
    await service.dispose();
  });
  it.each([
    'auth',
    'missing',
    'throw',
    'unavailable',
    'workdir',
    'skills',
  ] as const)(
    'closes without summary and starts fresh after summary %s failure',
    async (failure) => {
      const { id, service, runtime, store, options } = await setup();
      const first = service.send(id, 'hello');
      await tick();
      runtime.emit({ type: 'done', text: 'old answer', isError: false });
      await first;
      const old = service.getSnapshot().agents[id]!.session!;
      if (failure === 'throw')
        vi.spyOn(runtime, 'start').mockImplementationOnce(() => {
          throw new Error('spawn failed');
        });
      if (failure === 'unavailable') {
        vi.spyOn(runtime, 'detect').mockResolvedValueOnce({ available: false });
        await service.refreshRuntimes();
      }
      if (failure === 'workdir') {
        await store.patchAgent(id, { workdir: '../outside' });
        await service.refreshRuntimes();
      }
      if (failure === 'skills')
        vi.spyOn(store, 'loadSkills').mockRejectedValueOnce(
          new Error('skills failed'),
        );
      const closing = service.newConversation(id);
      const finished = expect(closing).resolves.toBeUndefined();
      await tick();
      if (failure === 'auth' || failure === 'missing')
        runtime.emit({
          type: 'done',
          text: failure === 'auth' ? 'Sign in' : 'No conversation found',
          isError: true,
          errorKind: failure === 'auth' ? 'auth' : 'other',
        });
      await finished;
      const state = service.getSnapshot().agents[id]!;
      expect(state.session!.sessionId).not.toBe(old.sessionId);
      expect(state.session).toMatchObject({ hasRun: false, carrySummary: '' });
      expect(state.messages).toEqual([]);
      expect(state.status).toBe('idle');
      const chats = await store.loadChats();
      expect(chats).toHaveLength(2);
      expect(
        chats.find((note) => note.path === old.path)!.frontmatter,
      ).toMatchObject({ closed: true, summary: '' });
      expect(chats.find((note) => note.path === old.path)!.body).toContain(
        'old answer',
      );
      const fresh = new ChatService(options);
      await fresh.initialize();
      expect(fresh.getSnapshot().agents[id]!.session!.sessionId).toBe(
        state.session!.sessionId,
      );
    },
  );
  it('refreshes edited and newly created agents without resetting active sessions', async () => {
    const { id, service, runtime, store } = await setup();
    const first = service.send(id, 'one');
    await tick();
    runtime.emit({ type: 'done', text: 'one', isError: false });
    await first;
    const sessionId = service.getSnapshot().agents[id]!.session!.sessionId;
    const other = await store.createAgent('Other');
    await store.patchAgent(other, { runtime: 'fake' });
    await store.patchAgent(id, { instructions: 'Updated instructions' });
    await service.refreshRuntimes();
    expect(service.getSnapshot().agents[other]!.status).toBe('idle');
    const second = service.send(id, 'two');
    await tick();
    expect(runtime.requests[1]!.systemPrompt).toContain('Updated instructions');
    expect(runtime.requests[1]!.sessionId).toBe(sessionId);
    runtime.emit({ type: 'done', text: 'two', isError: false });
    await second;
  });
  it('stops running and queued work, waits for cleanup and ignores late events', async () => {
    const { id, service, runtime, saves } = await setup();
    const sent = service.send(id, 'first');
    await tick();
    runtime.emit({ type: 'text', text: 'Partial' });
    const queued = service.send(id, 'second');
    expect(service.getSnapshot().agents[id]!.status).toBe('working');
    await service.stopAll();
    await Promise.all([sent, queued]);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.stops).toBe(1);
    expect(service.getSnapshot().agents[id]!.status).toBe('idle');
    expect(service.getSnapshot().queue).toEqual({ running: 0, queued: 0 });
    const count = saves.mock.calls.length;
    runtime.emit({ type: 'done', text: 'Late', isError: false });
    expect(saves.mock.calls.length).toBe(count);
    expect(service.getSnapshot().agents[id]!.messages.at(-1)).toMatchObject({
      content: 'Partial',
      cancelled: true,
      streaming: false,
    });
    await service.dispose();
    await expect(service.send(id, 'after unload')).rejects.toThrow('disposed');
  });
  it('closes a conversation with a runtime five-line summary and persists a fresh session across restart', async () => {
    const { id, service, runtime, store, options } = await setup();
    await store.createNote('Obi-I/Skills/summary.md', {}, 'Keep facts.');
    await store.patchAgent(id, { skills: ['Obi-I/Skills/summary.md'] });
    await service.refreshRuntimes();
    const sent = service.send(id, 'Remember pears');
    await tick();
    runtime.emit({ type: 'done', text: 'Pears remembered', isError: false });
    await sent;
    const oldId = runtime.requests[0]!.sessionId;
    const closing = service.newConversation(id);
    await tick();
    expect(runtime.requests[1]!.prompt).toMatch(/5.line|five.line/i);
    expect(runtime.requests[1]!.systemPrompt).toContain(
      '## Skill: summary\nKeep facts.',
    );
    expect(runtime.requests[1]!.resume).toBe(true);
    runtime.emit({
      type: 'done',
      text: '1. Pears\n2. Saved\n3. Context\n4. Goal\n5. Next',
      costUsd: 0.02,
      isError: false,
    });
    await closing;
    const notes = await store.loadChats();
    expect(notes).toHaveLength(2);
    expect(
      notes.find((note) => (note.frontmatter as { closed?: boolean }).closed)
        ?.body,
    ).toContain('## Summary\n\n1. Pears');
    const restarted = new ChatService(options);
    await restarted.initialize();
    const current = restarted.getSnapshot().agents[id]!.session!;
    expect(current.sessionId).not.toBe(oldId);
    expect(current.hasRun).toBe(false);
    const next = restarted.send(id, 'Continue');
    await tick();
    expect(runtime.requests[2]!.resume).toBe(false);
    expect(runtime.requests[2]!.prompt).toContain('1. Pears');
    runtime.emit({ type: 'done', text: 'Continuing', isError: false });
    await next;
  });
  it('restores history by stable ID after rename and resumes the same session with skill bodies', async () => {
    const { id, service, runtime, store, options } = await setup();
    await store.createNote('Obi-I/Skills/safe.md', {}, 'Protect the data.');
    await store.patchAgent(id, { skills: ['Obi-I/Skills/safe.md'] });
    const first = service.send(id, 'Remember apples');
    await tick();
    runtime.emit({ type: 'done', text: 'Apples remembered.', isError: false });
    await first;
    await store.patchAgent(id, { name: 'Renamed' });
    const restarted = new ChatService(options);
    await restarted.initialize();
    expect(
      restarted.getSnapshot().agents[id]!.messages.map((m) => m.content),
    ).toEqual(['Remember apples', 'Apples remembered.']);
    expect(restarted.getSnapshot().agents[id]!.history).toHaveLength(1);
    const followup = restarted.send(id, 'What fruit?');
    await tick();
    expect(runtime.requests[1]!.sessionId).toBe(runtime.requests[0]!.sessionId);
    expect(runtime.requests[1]!.resume).toBe(true);
    expect(runtime.requests[1]!.systemPrompt).toContain(
      '## Skill: safe\nProtect the data.',
    );
    runtime.emit({ type: 'done', text: 'Apples', isError: false });
    await followup;
  });
  it('streams in memory and persists each finished message once with session metadata', async () => {
    const { id, service, runtime, store, saves } = await setup();
    expect(runtime.requests).toHaveLength(0);
    const changes = vi.fn();
    const unsubscribe = service.subscribe(changes);
    const sent = service.send(id, 'Hello');
    await tick();
    expect(service.getSnapshot().agents[id]!.status).toBe('working');
    expect(saves).toHaveBeenCalledTimes(1);
    runtime.emit({ type: 'text', text: 'Hi' });
    runtime.emit({ type: 'tool', name: 'Read', summary: 'Read a note' });
    expect(saves).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().agents[id]!.messages[1]!.content).toBe('Hi');
    runtime.emit({
      type: 'done',
      text: 'Hi there',
      costUsd: 0.01,
      isError: false,
    });
    await sent;
    expect(saves).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().agents[id]!.status).toBe('idle');
    const note = (await store.loadChats())[0]!;
    expect(note.frontmatter).toMatchObject({
      agenthq: 'chat',
      agent: '[[Coder]]',
      agentId: id,
      costUsd: 0.01,
    });
    expect(note.body).toContain('### You');
    expect(note.body).toContain('### Coder');
    expect(note.body).toContain('> [!tools]-');
    expect(runtime.requests[0]!.resume).toBe(false);
    expect(runtime.requests[0]!.protectedPaths).toContain('/vault/.obsidian');
    expect(changes).toHaveBeenCalled();
    unsubscribe();
  });
});
