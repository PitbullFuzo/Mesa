import { z } from 'zod';
import type { NoteDocument } from './notes';
import { projectSlug } from './projects';
import type { Store } from './store';

/** Runs are only fired while Obsidian is open. A run this late or later counts as missed. */
export const MISSED_AFTER_MS = 2 * 60 * 1000;

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a clock time like 09:30.');
export const scheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time }),
  z.object({ kind: z.literal('weekdays'), time }),
  z.object({
    kind: z.literal('weekly'),
    day: z.number().int().min(0).max(6),
    time,
  }),
  z.object({
    kind: z.literal('every'),
    hours: z.number().int().min(1).max(168),
  }),
]);
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

const scheduleFields = z.object({
  agenthq: z.literal('schedule'),
  agentId: z.string().min(1),
  projectId: z.string().optional(),
  rule: scheduleRuleSchema,
  /** Per run: a run is refused once the previous run of this schedule reached this cap. */
  costCapUsd: z.number().nonnegative().optional(),
  missedRun: z.enum(['skip', 'run-once']).default('skip'),
  enabled: z.boolean().default(true),
  /** Held: a run was refused by the cost cap. Nothing runs until the owner resumes it from the Inbox or the page. */
  held: z.boolean().default(false),
  nextRun: z.string().optional(),
  lastRun: z.string().optional(),
  lastStatus: z.string().optional(),
  lastCostUsd: z.number().nonnegative().optional(),
});
export type ScheduleFields = z.infer<typeof scheduleFields>;

export interface Schedule extends ScheduleFields {
  name: string;
  path: string;
  /** The message sent to the agent on each run. */
  message: string;
}

/** Reads a Schedules note. Notes that do not parse are left out, not shown as schedules. */
export function parseSchedule(
  note: NoteDocument,
): Schedule | { problem: string } {
  const parsed = scheduleFields.safeParse(note.frontmatter);
  if (!parsed.success)
    return {
      problem: `${note.name}: ${parsed.error.issues[0]?.message ?? 'invalid schedule'}`,
    };
  return {
    ...parsed.data,
    name: note.name,
    path: note.path,
    message: note.body.trim(),
  };
}

export function loadValidSchedules(notes: NoteDocument[]): Schedule[] {
  return notes
    .map((note) => parseSchedule(note))
    .filter((entry): entry is Schedule => !('problem' in entry));
}

/** The next time a rule fires, strictly after `after`, in local time. */
export function nextRun(rule: ScheduleRule, after: Date): Date {
  if (rule.kind === 'every')
    return new Date(after.getTime() + rule.hours * 60 * 60 * 1000);
  const [h, m] = rule.time.split(':').map(Number) as [number, number];
  const candidate = new Date(after);
  candidate.setHours(h, m, 0, 0);
  for (let days = 0; days < 8; days++) {
    const dayOk =
      rule.kind === 'daily' ||
      (rule.kind === 'weekdays' &&
        candidate.getDay() >= 1 &&
        candidate.getDay() <= 5) ||
      (rule.kind === 'weekly' && candidate.getDay() === rule.day);
    if (dayOk && candidate.getTime() > after.getTime()) return candidate;
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(h, m, 0, 0);
  }
  return candidate;
}

/**
 * The run after the one that is due: anchored on the scheduled time when the run is on time, so an hourly rule stays on
 * the hour, and on `now` when the run was missed, so a catch-up never fires again at once.
 */
export function followingRun(schedule: Schedule, now: Date): Date {
  const due = schedule.nextRun ? new Date(schedule.nextRun) : now;
  const onTime = now.getTime() - due.getTime() <= MISSED_AFTER_MS;
  return nextRun(schedule.rule, onTime ? due : now);
}

export type DueDecision = 'wait' | 'fire' | 'skip-missed';

/**
 * What to do with a schedule at `now`. A run that is due is fired, unless Obsidian was closed when it was due and
 * the policy is skip (the default), in which case the run is skipped and the next one is scheduled.
 * A held schedule never fires.
 */
export function dueDecision(schedule: Schedule, now: Date): DueDecision {
  if (!schedule.enabled || schedule.held || !schedule.nextRun) return 'wait';
  const due = new Date(schedule.nextRun).getTime();
  if (now.getTime() < due) return 'wait';
  if (now.getTime() - due <= MISSED_AFTER_MS) return 'fire';
  return schedule.missedRun === 'run-once' ? 'fire' : 'skip-missed';
}

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Describes a rule in words for the schedule list. */
export function describeRule(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'daily':
      return `Every day at ${rule.time}`;
    case 'weekdays':
      return `Weekdays at ${rule.time}`;
    case 'weekly':
      return `Every ${DAYS[rule.day]} at ${rule.time}`;
    case 'every':
      return `Every ${rule.hours} hour${rule.hours === 1 ? '' : 's'}`;
  }
}

/** A local date and time, for example "Mon 20 Oct, 09:00". */
export function formatLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${DAYS_SHORT[date.getDay()]} ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How far away a time is, for example "in 19 h 27 min". */
export function relativeIn(ms: number): string {
  if (ms < 60000) return 'in under a minute';
  const minutes = Math.round(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `in ${hours} h ${rest} min` : `in ${rest} min`;
}

/** The form's live preview: the next run for the rule as it stands, computed the same way the scheduler does. */
export function previewLine(rule: ScheduleRule, now: Date): string {
  const next = nextRun(rule, now);
  return `Next run: ${formatLocal(next)} (${relativeIn(next.getTime() - now.getTime())})`;
}

/** The list's next-run text for an enabled schedule; "Paused" or "Held" otherwise. */
export function nextRunText(schedule: Schedule, now: Date): string {
  if (schedule.held) return 'Held: cost cap reached';
  if (!schedule.enabled || !schedule.nextRun) return 'Paused';
  const next = new Date(schedule.nextRun);
  return `${formatLocal(next)} (${relativeIn(next.getTime() - now.getTime())})`;
}

/** What the schedule form saves. */
export type ScheduleInput = Omit<
  ScheduleFields,
  'agenthq' | 'nextRun' | 'lastRun' | 'lastStatus' | 'lastCostUsd' | 'held'
> & { name: string; message: string };

/** Pauses or resumes a schedule. Resuming sets the next run from now. */
export async function setScheduleEnabled(
  store: Store,
  path: string,
  enabled: boolean,
  now: Date,
): Promise<void> {
  const note = await store.loadNote(path);
  const schedule = note ? loadValidSchedules([note])[0] : undefined;
  if (!note || !schedule) throw new Error('That schedule could not be read.');
  const frontmatter = {
    ...(note.frontmatter as Record<string, unknown>),
    enabled,
    nextRun: enabled
      ? nextRun(schedule.rule, now).toISOString()
      : schedule.nextRun,
  };
  await store.saveNote(path, frontmatter, note.body);
}

/** Resumes a held schedule: it is enabled again, its cost check starts fresh, and its next run is set from now. */
export async function resumeSchedule(
  store: Store,
  path: string,
  now: Date,
): Promise<void> {
  const note = await store.loadNote(path);
  const schedule = note ? loadValidSchedules([note])[0] : undefined;
  if (!note || !schedule) throw new Error('That schedule could not be read.');
  const frontmatter = {
    ...(note.frontmatter as Record<string, unknown>),
    enabled: true,
    held: false,
    lastCostUsd: 0,
    lastStatus: 'resumed',
    nextRun: nextRun(schedule.rule, now).toISOString(),
  };
  await store.saveNote(path, frontmatter, note.body);
}

/**
 * Changes a schedule's agent, project, message, rule, cap and policy. The next run is set again when the rule
 * changes. The file name and the run history are kept.
 */
export async function updateScheduleNote(
  store: Store,
  path: string,
  input: Omit<ScheduleInput, 'name'>,
  now: Date,
): Promise<void> {
  const note = await store.loadNote(path);
  const schedule = note ? loadValidSchedules([note])[0] : undefined;
  if (!note || !schedule) throw new Error('That schedule could not be read.');
  const ruleChanged =
    JSON.stringify(schedule.rule) !== JSON.stringify(input.rule);
  const { message, ...fields } = input;
  const merged = {
    ...(note.frontmatter as Record<string, unknown>),
    ...fields,
    projectId: fields.projectId,
    nextRun: ruleChanged
      ? nextRun(fields.rule, now).toISOString()
      : schedule.nextRun,
  };
  const frontmatter = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
  await store.saveNote(path, frontmatter, message);
}

/** Creates a Schedules note. Its first run is the next time the rule fires after `now`. */
export async function createScheduleNote(
  store: Store,
  root: string,
  input: ScheduleInput,
  now: Date,
): Promise<string> {
  const folder = `${root}/Schedules`;
  if (!(await store.exists(folder))) await store.createFolder(folder);
  const base = projectSlug(input.name);
  let path = `${folder}/${base}.md`;
  for (let suffix = 2; await store.exists(path); suffix++)
    path = `${folder}/${base} (${suffix}).md`;
  const { name: _name, message, ...fields } = input;
  const frontmatter: ScheduleFields = {
    agenthq: 'schedule',
    ...fields,
    held: false,
    missedRun: fields.missedRun,
    enabled: fields.enabled,
    nextRun: nextRun(fields.rule, now).toISOString(),
  };
  const clean = Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => value !== undefined),
  );
  await store.createNote(path, clean, message);
  return path;
}
