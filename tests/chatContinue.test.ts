import { describe, expect, it } from 'vitest';
import { ChatService, chatTitle, conversationTitle } from '../src/core/chat';
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
  finish(text = 'ok', isError = false) {
    const callback = this.callbacks.at(-1)!;
    const sessionId = this.requests.at(-1)!.sessionId;
    callback({ type: 'session', sessionId });
    callback({ type: 'done', text, isError });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const store = new MemoryStore();
  const coder = await store.createAgent('Coder');
  await store.patchAgent(coder, {
    runtime: 'fake',
    instructions: 'Be concise.',
  });
  const runtime = new ControlledRuntime();
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    agentLink: async () => '[[Coder]]',
  });
  await service.initialize();
  return { store, coder, runtime, service };
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

/** Starts a new conversation so the first one is saved as closed. */
async function closeFirst(
  service: ChatService,
  runtime: ControlledRuntime,
  agentId: string,
) {
  const closing = service.newConversation(agentId);
  await tick();
  runtime.finish('Five line summary');
  await closing;
}

describe('continuing conversations', () => {
  it('resumes the saved runtime session when the runtime still matches', async () => {
    const { coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello');
    const first = service.getSnapshot().agents[coder]!.session!;
    await closeFirst(service, runtime, coder);

    await service.continueChat(coder, first.path);
    expect(
      service.getSnapshot().agents[coder]!.messages.map((m) => m.content),
    ).toContain('hello');

    await converse(service, runtime, coder, 'more');
    const next = runtime.requests.at(-1)!;
    expect(next.resume).toBe(true);
    expect(next.sessionId).toBe(first.sessionId);
  });

  it('carries the transcript into a fresh session when the runtime differs', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello');
    const first = service.getSnapshot().agents[coder]!.session!;
    await closeFirst(service, runtime, coder);
    const note = (await store.loadChats()).find(
      (entry) => entry.path === first.path,
    )!;
    await store.saveNote(
      first.path,
      { ...(note.frontmatter as object), runtimeId: 'codex' },
      note.body,
    );

    await service.continueChat(coder, first.path);
    await converse(service, runtime, coder, 'again');
    const next = runtime.requests.at(-1)!;
    expect(next.resume).toBe(false);
    expect(next.prompt).toContain('Earlier conversation');
    expect(next.prompt).toContain('hello');
  });

  it('falls back to the transcript when the runtime reports the session is gone', async () => {
    const { coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello');
    const first = service.getSnapshot().agents[coder]!.session!;
    await closeFirst(service, runtime, coder);
    await service.continueChat(coder, first.path);

    const sent = service.send(coder, 'more');
    await tick();
    runtime.callbacks.at(-1)!({ type: 'session', sessionId: first.sessionId });
    runtime.callbacks.at(-1)!({
      type: 'done',
      text: 'No conversation found with session ID',
      isError: true,
    });
    await tick();
    runtime.finish('retried');
    await sent;

    const retry = runtime.requests.at(-1)!;
    expect(retry.resume).toBe(false);
    expect(retry.prompt).toContain('Earlier conversation');
    expect(retry.prompt).toContain('hello');
  });

  it('refuses while the agent is working', async () => {
    const { coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello');
    const first = service.getSnapshot().agents[coder]!.session!;
    await closeFirst(service, runtime, coder);
    const running = service.send(coder, 'busy');
    await tick();

    await expect(service.continueChat(coder, first.path)).rejects.toThrow(
      'running reply',
    );
    runtime.finish('done');
    await running;
  });
});

describe('conversation titles', () => {
  it('uses the first eight words of the first message', () => {
    expect(chatTitle('one two three four five six seven eight nine')).toBe(
      'one two three four five six seven eight',
    );
  });

  it('names new notes "<title> — <agent> — date time"', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello there');
    const [note] = await store.loadChats();
    expect(note!.path).toMatch(
      /Chats\/hello there — Coder — \d{4}-\d{2}-\d{2} \d{4}\.md$/,
    );
    expect(note!.frontmatter).toMatchObject({ title: 'hello there' });
  });

  it('derives the title of a note saved before titles existed', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello there');
    const [note] = await store.loadChats();
    const { title: _title, ...legacy } = note!.frontmatter as Record<
      string,
      unknown
    >;
    await store.saveNote(note!.path, legacy, note!.body);
    const [reloaded] = await store.loadChats();
    expect(conversationTitle(reloaded!)).toBe('hello there');
  });

  it('renames only the title and keeps the transcript', async () => {
    const { store, coder, runtime, service } = await setup();
    await converse(service, runtime, coder, 'hello there');
    const first = service.getSnapshot().agents[coder]!.session!;
    await closeFirst(service, runtime, coder);
    const before = (await store.loadChats()).find(
      (n) => n.path === first.path,
    )!;

    await service.renameChat(coder, first.path, 'Renamed chat');

    const after = (await store.loadChats()).find((n) => n.path === first.path)!;
    expect(after.frontmatter).toMatchObject({ title: 'Renamed chat' });
    expect(after.body).toBe(before.body);
  });
});
