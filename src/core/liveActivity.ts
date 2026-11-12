import type { AgentChatSnapshot, ChatStatus } from './chat';
import { t } from './i18n';
import type { NoteDocument } from './notes';

/** One agent on the Live activity page: what it is doing now and its latest step. */
export interface LiveRow {
  id: string;
  name: string;
  status: ChatStatus;
  /** The owner's words this agent is working on (first line, shortened), when it has a request. */
  doing?: string;
  /** The latest tool step of the reply being written, for example "Read: wiki/Plot.md". */
  lastStep?: string;
  /** How many steps the current reply has taken. */
  steps: number;
  /** When the current request started (ISO), for "for 2 min". */
  since?: string;
  /** Loop round, when a loop is running. */
  loop?: { round: number; rounds: number };
  hint?: string;
}

export const STATUS_LABEL: Record<ChatStatus, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  queued: 'Waiting to start',
  error: 'Stopped with a problem',
  idle: 'Idle',
  offline: 'Runtime not available',
};

/** The label for a status in the current language. */
export const statusLabel = (status: ChatStatus): string =>
  t(`status.${status}`);

const ORDER: ChatStatus[] = [
  'working',
  'needs-you',
  'queued',
  'error',
  'idle',
  'offline',
];

const short = (text: string, max = 140) => {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Rows for every agent, busiest first; idle agents keep their last request so the owner sees what they did. */
export function liveRows(
  agents: Record<string, AgentChatSnapshot>,
  loops: Record<string, { round: number; rounds: number }> = {},
): LiveRow[] {
  return Object.values(agents)
    .map((entry): LiveRow => {
      const messages = entry.messages;
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--)
        if (messages[i]!.role === 'user') {
          lastUser = i;
          break;
        }
      const reply = messages
        .slice(lastUser + 1)
        .filter((message) => message.role === 'assistant');
      const tools = reply.flatMap((message) => message.tools ?? []);
      const last = tools[tools.length - 1];
      const user = lastUser >= 0 ? messages[lastUser] : undefined;
      return {
        id: entry.agent.id,
        name: entry.agent.name,
        status: entry.status,
        doing: user ? short(user.content) || undefined : undefined,
        lastStep: last
          ? short(last.summary ? `${last.name}: ${last.summary}` : last.name)
          : undefined,
        steps: tools.length,
        since: user?.timestamp,
        loop: loops[entry.agent.id],
        hint: entry.hint,
      };
    })
    .sort(
      (a, b) =>
        ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
        a.name.localeCompare(b.name),
    );
}

/** "2 working · 1 needs you · 3 waiting to start", or "Nothing is running." */
export function liveSummary(rows: LiveRow[]): string {
  const count = (status: ChatStatus) =>
    rows.filter((row) => row.status === status).length;
  const needs = count('needs-you');
  const parts = [
    count('working') > 0
      ? t('live.summary.working', { n: count('working') })
      : '',
    needs === 1
      ? t('live.summary.needsOne')
      : needs > 1
        ? t('live.summary.needsMany', { n: needs })
        : '',
    count('queued') > 0 ? t('live.summary.queued', { n: count('queued') }) : '',
    count('error') > 0 ? t('live.summary.error', { n: count('error') }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('live.summary.none');
}

/** "for 45 s", "for 3 min", "for 1 h 5 min". */
export function elapsed(since: string, now: Date): string {
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - new Date(since).getTime()) / 1000),
  );
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return t('time.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutes', { n: minutes });
  return t('time.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** The latest lines of the Activity notes, newest first, as written: "14:02 Coder finished…" (older lines) or "2026-11-12 14:02 Coder finished…". */
export function recentActivity(notes: NoteDocument[], cap = 30): string[] {
  const lines: string[] = [];
  const months = [...notes]
    .filter((note) => /^\d{4}-\d{2}$/.test(note.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const note of months) {
    const entries = note.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^- (?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} /.test(line))
      .map((line) => line.slice(2))
      .reverse();
    for (const entry of entries) {
      lines.push(entry);
      if (lines.length >= cap) return lines;
    }
  }
  return lines;
}
