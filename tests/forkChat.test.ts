import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { buildCodexArgs } from '../src/core/runtimes/codex';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RunRequest, RuntimeAdapter } from '../src/core/runtimes/types';

const SESSION = '11111111-1111-4111-8111-111111111111';
const claudeRequest: RunRequest = {
  prompt: 'continue',
  systemPrompt: 'system',
  cwd: 'C:/vault/Work',
  sessionId: SESSION,
  resume: true,
  permission: 'read-only',
  protectedPaths: ['C:/vault/.obsidian'],
};

describe('fork: runtime flags verified in the installed help', () => {
  it('Claude Code adds --fork-session only when resuming a fork', () => {
    const forked = buildRuntimeArgs(
      { ...claudeRequest, forkSession: true },
      'C:/system.txt',
    );
    const at = forked.indexOf('--resume');
    expect(forked[at + 1]).toBe(SESSION);
    expect(forked[at + 2]).toBe('--fork-session');
    expect(
      buildRuntimeArgs({ ...claudeRequest, resume: false }, 'C:/system.txt'),
    ).not.toContain('--fork-session');
    expect(buildRuntimeArgs(claudeRequest, 'C:/system.txt')).not.toContain(
      '--fork-session',
    );
  });

  it('Codex forks with the exec fork subcommand instead of resume', () => {
    const codexRequest: RunRequest = {
      wholeComputerReadConfirmed: true,
      cwd: 'C:/Vault/Work',
      prompt: 'continue',
      systemPrompt: 'system',
      sessionId: SESSION,
      resume: true,
      permission: 'read-only',
      protectedPaths: ['C:/Vault/.obsidian'],
    };
    const forked = buildCodexArgs({ ...codexRequest, forkSession: true });
    expect(forked).toContain('fork');
    expect(forked).not.toContain('resume');
    expect(forked).toContain(SESSION);
    expect(buildCodexArgs(codexRequest)).toContain('resume');
  });
});

const paid = (text: string, costUsd = 0) => [
  { type: 'done' as const, text, isError: false, costUsd },
];

async function setup(runtimeId: 'fake' | 'claude-code') {
  const store = new MemoryStore('Mesa');
  const coder = await store.createAgent('Coder');
  await store.patchAgent(coder, { runtime: runtimeId });
  const fake = new FakeRuntime(
    (request) => paid(`reply to ${request.prompt}`),
    0,
  );
  const adapter: RuntimeAdapter =
    runtimeId === 'fake'
      ? fake
      : {
          id: 'claude-code',
          displayName: 'Claude Code',
          detect: () => fake.detect(),
          start: (request, onEvent) => fake.start(request, onEvent),
        };
  const service = new ChatService({
    store,
    adapters: [adapter],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Mesa/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  return { store, service, fake, coder };
}

describe('fork a conversation', () => {
  it('forks at an earlier message: the new chat carries exactly the messages up to it, and the original is unchanged', async () => {
    const { store, service, fake, coder } = await setup('fake');
    await service.send(coder, 'one');
    await service.send(coder, 'two');
    const source = service.getSnapshot().agents[coder]!.session!.path;
    const before = store.notes.get(source)!.body;

    const forked = await service.forkChat(coder, 1);

    expect(forked).not.toBe(source);
    expect(store.notes.get(source)!.body).toBe(before);
    const note = store.notes.get(forked)!;
    expect(note.frontmatter).toMatchObject({
      forkedFrom: { path: source, index: 1 },
    });
    const messages = service.getSnapshot().agents[coder]!.messages;
    expect(messages.map((message) => message.content)).toEqual([
      'one',
      'reply to one',
    ]);
    // Not the latest message, so the fork carries the transcript into a fresh session.
    await service.send(coder, 'three');
    const last = fake.requests.at(-1)!;
    expect(last.prompt).toContain('Previous conversation summary');
    expect(last.prompt).toContain('one');
    expect(last.prompt).not.toContain('two');
    expect(last.resume).toBe(false);
  });

  it('forks at the latest reply natively when the runtime supports it, and only for that first run', async () => {
    const { service, fake, coder } = await setup('claude-code');
    await service.send(coder, 'one');
    const sourceSession =
      service.getSnapshot().agents[coder]!.session!.sessionId;
    await service.forkChat(coder, 1);

    await service.send(coder, 'two');
    const first = fake.requests.at(-1)!;
    expect(first.resume).toBe(true);
    expect(first.forkSession).toBe(true);
    expect(first.sessionId).toBe(sourceSession);

    await service.send(coder, 'three');
    expect(fake.requests.at(-1)!.forkSession).toBe(false);
  });

  it('refuses a fork with no saved conversation and an index that does not exist', async () => {
    const { service, coder } = await setup('fake');
    await expect(service.forkChat(coder, 0)).rejects.toThrow(
      'Send a message before forking',
    );
    await service.send(coder, 'one');
    await expect(service.forkChat(coder, 9)).rejects.toThrow(
      'no longer available',
    );
  });
});
