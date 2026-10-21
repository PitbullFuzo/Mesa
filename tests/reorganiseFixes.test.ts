import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  confirmSummary,
  linksSettingProblem,
  planPath,
  validateMoves,
  type Move,
} from '../src/core/reorganise';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RuntimeAdapter } from '../src/core/runtimes/types';

describe('the plan run is restricted', () => {
  it('runs read-only with no vault, outside folders, web, browser or whole-computer read, in a fresh session', async () => {
    const store = new MemoryStore('Mesa');
    const planner = await store.createAgent('Planner');
    await store.patchAgent(planner, {
      runtime: 'fake',
      vaultAccess: 'write',
      webAccess: true,
    });
    const fake = new FakeRuntime(
      () => [{ type: 'done', text: 'a plan', isError: false, costUsd: 0.01 }],
      0,
    );
    const adapter: RuntimeAdapter = fake;
    const service = new ChatService({
      store,
      adapters: [adapter],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Reference'] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      memoryDelayMs: 60_000,
    });
    await service.initialize();

    const reply = await service.planReply(planner, 'the plan prompt');
    expect(reply).toEqual({ text: 'a plan', costUsd: 0.01 });
    const request = fake.requests.at(-1)!;
    expect(request.permission).toBe('read-only');
    expect(request.extraDirs).toEqual([]);
    expect(request.readDirs).toEqual([]);
    expect(request.webAccess).toBe(false);
    expect(request.canUseBrowser).toBe(false);
    expect(request.wholeComputerReadConfirmed).toBe(false);
    expect(request.resume).toBe(false);
    expect(request.cwd).toContain('Mesa/Work/');
    expect(request.prompt).toBe('the plan prompt');
    // The agent's own chat is not used: no message was added to it.
    expect(service.getSnapshot().agents[planner]?.messages ?? []).toEqual([]);
  });

  it('a second plan run gets a new session, not the first one', async () => {
    const store = new MemoryStore('Mesa');
    const planner = await store.createAgent('Planner');
    await store.patchAgent(planner, { runtime: 'fake' });
    const fake = new FakeRuntime(
      () => [{ type: 'done', text: 'ok', isError: false, costUsd: 0 }],
      0,
    );
    const service = new ChatService({
      store,
      adapters: [fake],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      memoryDelayMs: 60_000,
    });
    await service.initialize();
    await service.planReply(planner, 'one');
    await service.planReply(planner, 'two');
    const [first, second] = fake.requests.slice(-2);
    expect(first!.sessionId).not.toBe(second!.sessionId);
  });
});

describe('links must update before moving', () => {
  it('refuses apply and undo until Automatically update internal links is on', () => {
    expect(linksSettingProblem(true, 'apply')).toBeUndefined();
    expect(linksSettingProblem(false, 'apply')).toBe(
      'Turn on Settings → Files and links → Automatically update internal links, then apply again.',
    );
    expect(linksSettingProblem(undefined, 'undo')).toContain(
      'then undo again.',
    );
  });
});

describe('where the plan lives and what the owner sees', () => {
  it('the plan note goes under Mesa/Activity, where agents cannot edit it', () => {
    expect(planPath('Mesa', '2026-10-20 1430')).toBe(
      'Mesa/Activity/Reorganisation plan 2026-10-20 1430.md',
    );
  });

  it('the confirmation lists the first 20 moves, then how many more, and counts skipped lines', () => {
    const moves: Move[] = Array.from({ length: 25 }, (_, index) => ({
      from: `Inbox/n${index}.md`,
      to: `Notes/n${index}.md`,
      reason: '',
    }));
    const text = confirmSummary(moves, 3);
    expect(text).toContain('Inbox/n0.md → Notes/n0.md');
    expect(text).toContain('Inbox/n19.md → Notes/n19.md');
    expect(text).not.toContain('Inbox/n20.md');
    expect(text).toContain('and 5 more');
    expect(text).toContain('3 line(s) will be skipped');
  });

  it('only notes move: an image or other file is refused', () => {
    const { valid, problems } = validateMoves(
      [
        { from: 'Inbox/pic.png', to: 'Notes/pic.png', reason: '' },
        { from: 'Inbox/note.md', to: 'Notes/note.md', reason: '' },
      ],
      new Set(['Inbox/pic.png', 'Inbox/note.md']),
      'Mesa',
      '.obsidian',
    );
    expect(valid.map((move) => move.from)).toEqual(['Inbox/note.md']);
    expect(problems).toEqual([
      'Only notes (.md) can be moved: Inbox/pic.png → Notes/pic.png',
    ]);
  });
});
