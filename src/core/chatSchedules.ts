import {
  dueDecision,
  followingRun,
  loadValidSchedules,
  type Schedule,
  type ScheduleFields,
} from './schedules';
import type { Store } from './store';

/** True when the schedule's last run reached its cost cap, so nothing runs until the owner resumes it. */
export function scheduleHeldByCap(schedule: Schedule): boolean {
  return (
    schedule.costCapUsd !== undefined &&
    (schedule.lastCostUsd ?? 0) >= schedule.costCapUsd
  );
}

/** Writes changed fields to a Schedules note, keeping the rest of the note as it is. */
export async function patchScheduleNote(
  store: Store,
  path: string,
  patch: Partial<ScheduleFields>,
): Promise<void> {
  const note = await store.loadNote(path);
  if (!note) return;
  const merged = {
    ...(note.frontmatter as Record<string, unknown>),
    ...patch,
  };
  const frontmatter = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
  await store.saveNote(path, frontmatter, note.body);
}

/** Marks every schedule that is due at `now` as running (or missed) and hands each due one to `run`. */
export async function startDueSchedules(
  store: Store,
  managedRoot: string,
  now: Date,
  run: (schedule: Schedule) => void,
): Promise<void> {
  const notes = await store.loadNotesUnder(`${managedRoot}/Schedules`);
  for (const schedule of loadValidSchedules(notes)) {
    const decision = dueDecision(schedule, now);
    if (decision === 'wait') continue;
    const nextRunAt = followingRun(schedule, now).toISOString();
    if (decision === 'skip-missed') {
      await patchScheduleNote(store, schedule.path, {
        nextRun: nextRunAt,
        lastStatus: 'missed: skipped',
      });
      continue;
    }
    // The next run is set before this one starts, so a slow run cannot fire the same schedule twice.
    await patchScheduleNote(store, schedule.path, {
      nextRun: nextRunAt,
      lastRun: now.toISOString(),
      lastStatus: 'running',
    });
    run(schedule);
  }
}
