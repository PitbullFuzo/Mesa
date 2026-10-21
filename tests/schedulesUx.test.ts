import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  createScheduleNote,
  loadValidSchedules,
  nextRunText,
  previewLine,
  relativeIn,
  resumeSchedule,
  nextRun,
  updateScheduleNote,
  type Schedule,
} from '../src/core/schedules';
import { FakeRuntime } from '../src/core/runtimes/fake';

const paid = (text: string, costUsd = 0) => [
  { type: 'done' as const, text, isError: false, costUsd },
];
const HOUR = 60 * 60 * 1000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const savedTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = savedTz;
});

async function setup(costUsd = 0) {
  const store = new MemoryStore('Obi-I');
  const coder = await store.createAgent('Coder');
  await store.patchAgent(coder, { runtime: 'fake' });
  const runtime = new FakeRuntime(() => paid('done', costUsd), 0);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  return { store, service, runtime, coder };
}

async function readSchedule(store: MemoryStore): Promise<Schedule> {
  return loadValidSchedules(await store.loadNotesUnder('Obi-I/Schedules'))[0]!;
}

describe('schedules page: local time and the live preview', () => {
  it('shows the next run in local time, the same in two time zones for the same clock', () => {
    const lines = ['Europe/Lisbon', 'Pacific/Auckland'].map((zone) => {
      process.env.TZ = zone;
      // Monday 19 Oct 2026, 10:00 on the local clock.
      const now = new Date(2026, 9, 19, 10, 0);
      return previewLine({ kind: 'daily', time: '09:00' }, now);
    });
    expect(lines).toEqual([
      'Next run: Tue 20 Oct, 09:00 (in 23 h 0 min)',
      'Next run: Tue 20 Oct, 09:00 (in 23 h 0 min)',
    ]);
  });

  it('previews the weekday rule the way the scheduler computes it', () => {
    process.env.TZ = 'Europe/Lisbon';
    // Friday 23 Oct 2026, 10:00: the next weekday run at 09:00 is Monday.
    const now = new Date(2026, 9, 23, 10, 0);
    const preview = previewLine({ kind: 'weekdays', time: '09:00' }, now);
    expect(preview).toBe('Next run: Mon 26 Oct, 09:00 (in 72 h 0 min)');
    expect(
      nextRun({ kind: 'weekdays', time: '09:00' }, now).getTime() -
        now.getTime(),
    ).toBe(72 * HOUR);
  });

  it('describes how far away a run is in words', () => {
    expect(relativeIn(30 * 1000)).toBe('in under a minute');
    expect(relativeIn(5 * 60 * 1000)).toBe('in 5 min');
    expect(relativeIn(3 * HOUR + 25 * 60 * 1000)).toBe('in 3 h 25 min');
  });

  it('shows held and paused schedules in words instead of a time', () => {
    const base = {
      agentId: 'a',
      rule: { kind: 'daily', time: '09:00' },
      missedRun: 'skip',
      name: 'n',
      path: 'p',
      message: 'm',
    } as const;
    expect(
      nextRunText(
        { ...base, enabled: true, held: true } as Schedule,
        new Date(),
      ),
    ).toBe('Held: cost cap reached');
    expect(
      nextRunText(
        { ...base, enabled: false, held: false } as Schedule,
        new Date(),
      ),
    ).toBe('Paused');
  });
});

describe('schedules page: create, edit, delete, held, run now', () => {
  it('moves a schedule to another project and recomputes its next run when the rule changes', async () => {
    const { store, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Obi-I',
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
    const path = 'Obi-I/Schedules/Standup.md';
    await updateScheduleNote(
      store,
      path,
      {
        agentId: coder,
        projectId: 'p2',
        rule: { kind: 'every', hours: 6 },
        message: 'Post again.',
        missedRun: 'skip',
        enabled: true,
      },
      created,
    );
    const after = await readSchedule(store);
    expect(after.projectId).toBe('p2');
    expect(after.message).toBe('Post again.');
    expect(new Date(after.nextRun!).getTime()).toBe(
      created.getTime() + 6 * HOUR,
    );
    expect(after.path).toBe(path);
  });

  it('deletes a schedule by moving its note to the trash', async () => {
    const { store, coder } = await setup();
    await createScheduleNote(
      store,
      'Obi-I',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'skip',
        enabled: true,
        message: 'Post.',
      },
      new Date(),
    );
    await store.trashNote('Obi-I/Schedules/Standup.md');
    expect(await store.loadNotesUnder('Obi-I/Schedules')).toEqual([]);
  });

  it('holds a schedule whose last run reached its cost cap, adds an Inbox item, and resumes it from the Inbox', async () => {
    const { store, service, runtime, coder } = await setup(0.6);
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Obi-I',
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
    await service.tickSchedules(new Date(created.getTime() + 2 * HOUR + 1000));
    await wait(50);
    expect((await readSchedule(store)).held).toBe(true);
    const item = service
      .getSnapshot()
      .inbox?.find((entry) => entry.kind === 'schedule-held');
    expect(item).toBeDefined();
    expect(item!.message).toContain('Standup');
    // Held: nothing runs on later ticks.
    await service.tickSchedules(new Date(created.getTime() + 3 * HOUR + 1000));
    await wait(50);
    expect(runtime.requests).toHaveLength(1);
    // Resuming from the Inbox clears the hold; the next due run is then allowed to run again.
    await service.resolveInbox(item!.id, 'retry');
    const resumed = await readSchedule(store);
    expect(resumed.held).toBe(false);
    expect(resumed.enabled).toBe(true);
    expect(
      service.getSnapshot().inbox?.find((entry) => entry.id === item!.id)
        ?.resolved,
    ).toBe(true);
  });

  it('runs a schedule once now without changing its regular next run', async () => {
    const { store, service, runtime, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Obi-I',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'skip',
        enabled: true,
        message: 'Post now.',
      },
      created,
    );
    const before = (await readSchedule(store)).nextRun;
    await service.runScheduleNow('Obi-I/Schedules/Standup.md');
    await wait(50);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]!.prompt).toBe('Post now.');
    expect((await readSchedule(store)).nextRun).toBe(before);
  });

  it('lets a held schedule be resumed from the schedule store with a fresh cost check', async () => {
    const { store, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Obi-I',
      {
        name: 'Standup',
        agentId: coder,
        rule: { kind: 'every', hours: 1 },
        missedRun: 'skip',
        enabled: true,
        costCapUsd: 0.5,
        message: 'Post.',
      },
      created,
    );
    await resumeSchedule(store, 'Obi-I/Schedules/Standup.md', created);
    const after = await readSchedule(store);
    expect(after.held).toBe(false);
    expect(after.lastCostUsd).toBe(0);
  });
});

describe('scheduler tick guard', () => {
  it('does not fire a due run twice when two ticks overlap', async () => {
    const { store, service, runtime, coder } = await setup();
    const created = new Date(2026, 9, 19, 8, 0);
    await createScheduleNote(
      store,
      'Obi-I',
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
    const due = new Date(created.getTime() + HOUR + 1000);
    await Promise.all([service.tickSchedules(due), service.tickSchedules(due)]);
    await wait(100);
    expect(runtime.requests).toHaveLength(1);
  });
});
