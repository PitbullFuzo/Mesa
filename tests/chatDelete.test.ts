import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
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
  async detect() {
    return { available: true };
  }
  start(request: RunRequest, callback: (event: RunEvent) => void) {
    this.requests.push(request);
    this.callbacks.push(callback);
    return { stop: async () => {} };
  }
  finish(text = 'ok') {
    const callback = this.callbacks.at(-1)!;
    const sessionId = this.requests.at(-1)!.sessionId;
    callback({ type: 'session', sessionId });
    callback({ type: 'done', text, isError: false });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const store = new MemoryStore();
  const coder = await store.createAgent('Coder');
  const designer = await store.createAgent('Designer');
  for (const id of [coder, designer])
    await store.patchAgent(id, {
      runtime: 'fake',
      instructions: 'Be concise.',
    });
  const runtime = new ControlledRuntime();
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Mesa/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    agentLink: async () => '[[Coder]]',
  });
  await service.initialize();
  return { store, coder, designer, runtime, service };
}

async function converse(
  service: ChatService,
  runtime: ControlledRuntime,
  agentId: string,
  text: string,
) {
  const sent = service.send(agentId, text);
  await tick();
  runtime.finish(`reply to ${text}`);
  await sent;
}

describe('chat history deletion', () => {
  it('trashes only the chosen agent’s chat notes and resets its conversation', async () => {
    const { store, coder, designer, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hi coder');
    await converse(service, runtime, designer, 'hi designer');
    expect(await store.loadChats()).toHaveLength(2);

    expect(await service.deleteChats(coder)).toBe(1);

    const remaining = await store.loadChats();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.frontmatter).toMatchObject({ agentId: designer });
    const snapshot = service.getSnapshot().agents[coder]!;
    expect(snapshot.session).toBeNull();
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.history).toEqual([]);
  });

  it("deletes every agent's chat notes when no agent is given", async () => {
    const { store, coder, designer, runtime, service } = await setup();
    await converse(service, runtime, coder, 'a');
    await converse(service, runtime, designer, 'b');

    expect(await service.deleteChats(null)).toBe(2);

    expect(await store.loadChats()).toEqual([]);
    expect(service.getSnapshot().agents[designer]!.session).toBeNull();
  });

  it('deletes only the selected note and keeps the open conversation', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'open one');
    const session = service.getSnapshot().agents[coder]!.session!;
    await store.createNote(
      'Mesa/Chats/old.md',
      { agenthq: 'chat', agentId: coder, started: '2026-10-01T00:00:00Z' },
      '',
    );

    expect(await service.deleteChats(coder, ['Mesa/Chats/old.md'])).toBe(1);

    const remaining = await store.loadChats();
    expect(remaining.map((note) => note.path)).toEqual([session.path]);
    expect(service.getSnapshot().agents[coder]!.session?.path).toBe(
      session.path,
    );
  });

  it('deletes selected notes across agents and refuses only for an owner that is busy', async () => {
    const { store, coder, designer, runtime, service } = await setup();
    await converse(service, runtime, coder, 'coder note');
    await converse(service, runtime, designer, 'designer note');
    const notes = await store.loadChats();
    const coderNote = notes.find(
      (note) => (note.frontmatter as { agentId: string }).agentId === coder,
    )!;
    const designerNote = notes.find(
      (note) => (note.frontmatter as { agentId: string }).agentId === designer,
    )!;
    const running = service.send(designer, 'busy');
    await tick();

    expect(await service.deleteChats(null, [coderNote.path])).toBe(1);

    const remaining = await store.loadChats();
    expect(remaining.map((note) => note.path)).toEqual([designerNote.path]);
    runtime.finish('done');
    await running;
  });

  it('refuses while the agent is working and leaves its notes intact', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'first');
    const running = service.send(coder, 'second');
    await tick();

    await expect(service.deleteChats(coder)).rejects.toThrow('running reply');
    expect(await store.loadChats()).toHaveLength(1);

    runtime.finish('done');
    await running;
  });

  it('only touches the given note when a path list is passed', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'keep me');
    const session = service.getSnapshot().agents[coder]!.session!;

    expect(await service.deleteChats(coder, ['Mesa/Chats/missing.md'])).toBe(0);
    expect(await store.loadChats()).toHaveLength(1);
    expect(service.getSnapshot().agents[coder]!.session?.path).toBe(
      session.path,
    );
  });

  it('starts a fresh runtime session with no carried-over summary after deletion', async () => {
    const { coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'before');
    const oldSession = runtime.requests[0]!.sessionId;
    await service.deleteChats(coder);

    await converse(service, runtime, coder, 'after');
    const next = runtime.requests.at(-1)!;
    expect(next.resume).toBe(false);
    expect(next.sessionId).not.toBe(oldSession);
    expect(next.prompt).not.toContain('Previous conversation summary');
  });
});
