import { describe, expect, it } from 'vitest';
import type { NoteDocument } from '../src/core/notes';
import {
  describeRule,
  dueDecision,
  loadValidSchedules,
  nextRun,
  parseSchedule,
  type Schedule,
} from '../src/core/schedules';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi, 0, 0);
const schedule = (over: Partial<Schedule>): Schedule =>
  ({
    agentId: 'coder',
    rule: { kind: 'daily', time: '09:30' },
    missedRun: 'skip',
    enabled: true,
    name: 'Standup',
    path: 'Obi-I/Schedules/Standup.md',
    message: 'Post the standup.',
    ...over,
  }) as Schedule;

describe('schedules: next run', () => {
  it('fires daily at the time, and today only if that time is still ahead', () => {
    expect(
      nextRun({ kind: 'daily', time: '09:30' }, at(2026, 10, 19, 8)),
    ).toEqual(at(2026, 10, 19, 9, 30));
    expect(
      nextRun({ kind: 'daily', time: '09:30' }, at(2026, 10, 19, 10)),
    ).toEqual(at(2026, 10, 20, 9, 30));
  });

  it('skips the weekend for weekdays', () => {
    // 2026-10-23 is a Friday; after Friday 10:00 the next weekday run is Monday.
    expect(
      nextRun({ kind: 'weekdays', time: '09:00' }, at(2026, 10, 23, 10)),
    ).toEqual(at(2026, 10, 26, 9));
  });

  it('fires on the chosen weekday', () => {
    // 2026-10-18 is a Sunday; weekly on Wednesday (3) is 2026-10-21.
    expect(
      nextRun({ kind: 'weekly', day: 3, time: '08:00' }, at(2026, 10, 18, 12)),
    ).toEqual(at(2026, 10, 21, 8));
  });

  it('repeats every N hours from the last run', () => {
    expect(nextRun({ kind: 'every', hours: 6 }, at(2026, 10, 19, 1))).toEqual(
      at(2026, 10, 19, 7),
    );
  });

  it('describes the rule in words', () => {
    expect(describeRule({ kind: 'weekly', day: 1, time: '09:00' })).toBe(
      'Every Monday at 09:00',
    );
    expect(describeRule({ kind: 'every', hours: 1 })).toBe('Every 1 hour');
  });
});

describe('schedules: due decision and missed runs', () => {
  const due = at(2026, 10, 19, 9, 30).toISOString();

  it('waits before the run is due, and while the schedule is paused', () => {
    expect(
      dueDecision(schedule({ nextRun: due }), at(2026, 10, 19, 9, 29)),
    ).toBe('wait');
    expect(
      dueDecision(
        schedule({ nextRun: due, enabled: false }),
        at(2026, 10, 19, 9, 31),
      ),
    ).toBe('wait');
  });

  it('fires a run that is due now', () => {
    expect(
      dueDecision(schedule({ nextRun: due }), at(2026, 10, 19, 9, 31)),
    ).toBe('fire');
  });

  it('skips a run missed while Obsidian was closed, by default', () => {
    expect(dueDecision(schedule({ nextRun: due }), at(2026, 10, 19, 14))).toBe(
      'skip-missed',
    );
  });

  it('runs a missed run once on open when the policy is run once', () => {
    expect(
      dueDecision(
        schedule({ nextRun: due, missedRun: 'run-once' }),
        at(2026, 10, 19, 14),
      ),
    ).toBe('fire');
  });
});

describe('schedules: notes', () => {
  const note = (frontmatter: Record<string, unknown>): NoteDocument => ({
    path: 'Obi-I/Schedules/Standup.md',
    name: 'Standup',
    frontmatter,
    body: 'Post the standup.',
  });

  it('reads a valid schedule and leaves out an invalid one', () => {
    const good = note({
      agenthq: 'schedule',
      agentId: 'coder',
      rule: { kind: 'daily', time: '09:30' },
    });
    const bad = note({
      agenthq: 'schedule',
      agentId: 'coder',
      rule: { kind: 'daily', time: '9.30' },
    });
    expect(loadValidSchedules([good, bad]).map((entry) => entry.name)).toEqual([
      'Standup',
    ]);
    expect(parseSchedule(bad)).toHaveProperty('problem');
  });
});
