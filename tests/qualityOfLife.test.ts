import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { withAttachedNote } from '../src/core/composer';
import { contextView, planMeterText, planResetText } from '../src/core/context';
import { MemoryStore } from '../src/core/memoryStore';
import { ensureObi, OBI_ID } from '../src/core/obi';
import { StreamJsonParser } from '../src/core/runtimes/claudeCode';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '../src/core/runtimes/types';
import {
  parseSlash,
  skillMessage,
  slashMatches,
  takeNamed,
} from '../src/core/slash';

describe('the context indicator', () => {
  it('shows a percentage and warns above 80%', () => {
    expect(contextView({ used: 46_000, window: 200_000 })).toMatchObject({
      text: '23%',
      warn: false,
    });
    const high = contextView({ used: 170_000, window: 200_000 });
    expect(high).toMatchObject({ text: '85%', warn: true });
    expect(high.tip).toContain('new chat or Fork');
  });

  it('shows tokens without a bar when the window is not reported, and "unknown" when nothing is', () => {
    const noWindow = contextView({ used: 41_000 });
    expect(noWindow.text).toBe('41,000 tokens');
    expect(noWindow.fraction).toBeUndefined();
    expect(contextView(undefined).text).toBe('unknown');
  });
});

describe('what Claude Code reports', () => {
  const parse = (name: string) => {
    const bytes = readFileSync(
      new URL(`./fixtures/runtime-${name}.jsonl`, import.meta.url),
    );
    const events: RunEvent[] = [];
    const parser = new StreamJsonParser((event) => events.push(event));
    parser.push(bytes);
    parser.end();
    return events;
  };

  it('gives the plan windows from the stream, without any credential', () => {
    const usage = parse('normal').find((event) => event.type === 'plan-usage');
    expect(usage).toBeDefined();
    if (usage?.type !== 'plan-usage') return;
    expect(planMeterText(usage.usage)).toBe('5h 0% · week 38%');
    expect(planResetText(usage.usage)).toContain('Weekly window resets');
  });

  it('gives the context used and the model window with the final result', () => {
    const done = parse('normal').find((event) => event.type === 'done');
    expect(done?.type === 'done' && done.context).toEqual({
      used: 10 + 7667 + 0 + 60,
      window: 200_000,
    });
  });

  it('has no meter text when nothing was reported', () => {
    expect(planMeterText(undefined)).toBe('');
    expect(planMeterText({})).toBe('');
  });
});

describe('slash commands', () => {
  it('offers the matching commands while the first word is typed', () => {
    expect(slashMatches('/').map((command) => command.name)).toEqual([
      'new',
      'fork',
      'skill',
      'compact',
      'project',
      'help',
    ]);
    expect(slashMatches('/pr').map((command) => command.name)).toEqual([
      'project',
    ]);
    expect(slashMatches('hello /new')).toEqual([]);
    expect(slashMatches('/new now')).toEqual([]);
  });

  it('recognises the six commands and sends anything else as text', () => {
    expect(parseSlash('/new')).toEqual({ name: 'new', rest: '' });
    expect(parseSlash('/skill Review  check this')).toEqual({
      name: 'skill',
      rest: 'Review  check this',
    });
    expect(parseSlash('/Help')).toEqual({ name: 'help', rest: '' });
    expect(parseSlash('/unknown thing')).toBeNull();
    expect(parseSlash('/usr/bin is a path')).toBeNull();
    expect(parseSlash('plain text')).toBeNull();
  });

  it('finds a skill or project by name, longest name first, and keeps the rest as the message', () => {
    const skills = [
      { name: 'Review', body: 'short' },
      { name: 'Review code', body: 'long' },
    ];
    expect(takeNamed(skills, 'review code please look')).toEqual({
      item: skills[1],
      rest: 'please look',
    });
    expect(takeNamed(skills, 'Reviewer')).toBeNull();
    expect(takeNamed(skills, 'nothing')).toBeNull();
  });

  it('puts the skill with this one message', () => {
    const text = skillMessage({ name: 'Review', body: ' Be strict. ' }, 'Look');
    expect(text).toContain('## Skill: Review\nBe strict.');
    expect(text.endsWith('---\nLook')).toBe(true);
  });
});

describe('an attached note', () => {
  it('comes first, marked as attached by the owner, and says when it was cut', () => {
    const text = withAttachedNote('Summarise', {
      path: 'Notes/a.md',
      content: 'Body',
      truncated: true,
    });
    expect(text).toContain('The owner attached this note (`Notes/a.md`)');
    expect(text).toContain('cut because it is long');
    expect(text.endsWith('---\nSummarise')).toBe(true);
  });
});

describe('the chat service passes them on', () => {
  class Reporting implements RuntimeAdapter {
    id = 'fake' as const;
    displayName = 'Test runtime';
    async detect() {
      return { available: true };
    }
    start(request: RunRequest, callback: (event: RunEvent) => void) {
      queueMicrotask(() => {
        callback({ type: 'session', sessionId: request.sessionId });
        callback({
          type: 'plan-usage',
          usage: { fiveHour: { utilization: 0.11, resetsAt: 1 } },
        });
        callback({
          type: 'done',
          text: 'ok',
          isError: false,
          context: { used: 1000, window: 4000 },
        });
      });
      return { stop: async () => {} };
    }
  }

  it('keeps the plan usage and the context of the last reply, and clears the context for a new chat', async () => {
    const store = new MemoryStore();
    await ensureObi(store, store.root);
    await store.patchAgent(OBI_ID, { runtime: 'fake' });
    const service = new ChatService({
      store,
      adapters: [new Reporting()],
      settings: () => ({
        maxParallelRuns: 2,
        allowedFolders: ['Mesa/Work'],
      }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      agentLink: async () => '[[Obi]]',
    });
    await service.initialize();
    expect(service.getSnapshot().agents[OBI_ID]!.context).toBeUndefined();
    await service.send(OBI_ID, 'hello');
    const snapshot = service.getSnapshot();
    expect(snapshot.planUsage).toEqual({
      fiveHour: { utilization: 0.11, resetsAt: 1 },
    });
    expect(snapshot.agents[OBI_ID]!.context).toEqual({
      used: 1000,
      window: 4000,
    });
  });
});
