import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  createScheduleNote,
  loadValidSchedules,
  type Schedule,
} from '../src/core/schedules';
import { FakeRuntime } from '../src/core/runtimes/fake';

const paid = (text: string, costUsd = 0) => [
  { type: 'done' as const, text, isError: false, costUsd },
];
const HOUR = 60 * 60 * 1000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(costUsd = 0) {
  const store = new MemoryStore('Mesa');
  const coder = await store.createAgent('Coder');
  await store.patchAgent(coder, { runtime: 'fake' });
  const runtime = new FakeRuntime(() => paid('done', costUsd), 0);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Mesa/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  return { store, service, runtime, coder };
}

async function readSchedule(store: MemoryStore): Promise<Schedule> {
  return loadValidSchedules(await store.loadNotesUnder('Mesa/Schedules'))[0]!;
}

describe('schedules run through the queue', () => {
  it('fires a due schedule as a chat turn, records the run, and sets the next one', async () => {
    const { store, service, runtime, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Mesa',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'skip',
        enabled: true,
        message: 'Post the standup.',
      },
      created,
    );
    await service.tickSchedules(new Date(created.getTime() + HOUR - 1000));
    expect(runtime.requests).toHaveLength(0);
    await service.tickSchedules(new Date(created.getTime() + HOUR + 1000));
    await wait(100);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]!.prompt).toBe('Post the standup.');
    const after = await readSchedule(store);
    expect(after.lastStatus).toBe('done');
    expect(new Date(after.nextRun!).getTime()).toBe(
      created.getTime() + 2 * HOUR,
    );
  });

  it('skips a missed run by default and runs nothing', async () => {
    const { store, service, runtime, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Mesa',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'skip',
        enabled: true,
        message: 'Post.',
      },
      created,
    );
    await service.tickSchedules(new Date(created.getTime() + 5 * HOUR));
    await wait(50);
    expect(runtime.requests).toHaveLength(0);
    expect((await readSchedule(store)).lastStatus).toBe('missed: skipped');
  });

  it('does not run a paused schedule', async () => {
    const { store, service, runtime, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Mesa',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'run-once',
        enabled: false,
        message: 'Post.',
      },
      created,
    );
    await service.tickSchedules(new Date(created.getTime() + 3 * HOUR));
    await wait(50);
    expect(runtime.requests).toHaveLength(0);
  });

  it('refuses the next run once the previous run reached the per-run cost cap', async () => {
    const { store, service, runtime, coder } = await setup(0.6);
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Mesa',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'run-once',
        enabled: true,
        costCapUsd: 0.5,
        message: 'Post.',
      },
      created,
    );
    await service.tickSchedules(new Date(created.getTime() + HOUR + 1000));
    await wait(100);
    expect(runtime.requests).toHaveLength(1);
    await service.tickSchedules(new Date(created.getTime() + 2 * HOUR + 1000));
    await wait(50);
    expect(runtime.requests).toHaveLength(1);
    expect((await readSchedule(store)).lastStatus).toBe(
      'held: cost cap reached',
    );
  });
});
