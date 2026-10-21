import type { NoteDocument } from './notes';
import { logEntries, memoryCostFromLog } from './memory';
import { PROJECT_STATUSES, type Project } from './projects';

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Board columns are the project statuses, in order. */
export const BOARD_COLUMNS = PROJECT_STATUSES;

/** Task columns on a project page, mapped from the task statuses. Failed, needs-you and cancelled tasks sit in progress and show their own status. */
export const TASK_COLUMNS = [
  { id: 'todo', label: 'To do', statuses: ['queued'] },
  {
    id: 'progress',
    label: 'In progress',
    statuses: ['running', 'failed', 'needs-you', 'cancelled'],
  },
  { id: 'review', label: 'In review', statuses: ['verifying'] },
  { id: 'done', label: 'Done', statuses: ['passed'] },
] as const;

/** The facts of one task note that the board needs. */
export interface TaskFacts {
  name: string;
  projectId: string | null;
  status: string;
  costUsd: number;
}

/** What the Log says about a project: memory spend, the last entry's time, and the recent entries. */
export interface ProjectLogSummary {
  memoryCostUsd: number;
  lastActivity: string | null;
  tail: string[];
}

/** Counts, progress and cost for one project, computed from its task notes and Log. Nothing is stored. */
export interface ProjectStats {
  total: number;
  done: number;
  progress: number;
  costUsd: number;
  lastActivity: string | null;
}

export function taskFacts(note: NoteDocument): TaskFacts {
  const fm = note.frontmatter as Record<string, unknown>;
  return {
    name: note.name,
    projectId: typeof fm.projectId === 'string' ? fm.projectId : null,
    status: typeof fm.status === 'string' ? fm.status : '',
    costUsd:
      Number(fm.workerTotalCostUsd ?? 0) + Number(fm.verifierTotalCostUsd ?? 0),
  };
}

export function taskColumnOf(status: string): string | null {
  return (
    TASK_COLUMNS.find((column) =>
      (column.statuses as readonly string[]).includes(status),
    )?.id ?? null
  );
}

export function logSummary(log: NoteDocument | null): ProjectLogSummary {
  const entries = logEntries(log);
  const lastLine = entries.at(-1) ?? '';
  const time = /^- (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(lastLine)?.[1] ?? null;
  return {
    memoryCostUsd: memoryCostFromLog(entries),
    lastActivity: time,
    tail: entries.slice(-20),
  };
}

/** Facts of one direct chat note that the cost figures need. costUsd is the chat session's running total. */
export interface ChatFacts {
  projectId: string | null;
  costUsd: number;
}

export function chatFacts(note: NoteDocument): ChatFacts {
  const fm = note.frontmatter as Record<string, unknown>;
  return {
    projectId: typeof fm.projectId === 'string' ? fm.projectId : null,
    costUsd: typeof fm.costUsd === 'number' ? fm.costUsd : 0,
  };
}

/**
 * Money spent on a project: its task runs, its direct chats and the memory work in its Log. The project
 * board and the cost cap both use this, so they cannot disagree.
 */
export function projectSpendUsd(
  projectId: string,
  tasks: TaskFacts[],
  chats: ChatFacts[],
  memoryCostUsd: number,
): number {
  const taskCost = tasks
    .filter((task) => task.projectId === projectId)
    .reduce((sum, task) => sum + task.costUsd, 0);
  const chatCost = chats
    .filter((chat) => chat.projectId === projectId)
    .reduce((sum, chat) => sum + chat.costUsd, 0);
  return taskCost + chatCost + memoryCostUsd;
}

export function projectStats(
  project: Project,
  tasks: TaskFacts[],
  chats: ChatFacts[],
  log: ProjectLogSummary | undefined,
): ProjectStats {
  const own = tasks.filter((task) => task.projectId === project.id);
  const done = own.filter((task) => task.status === 'passed').length;
  return {
    total: own.length,
    done,
    progress: own.length === 0 ? 0 : done / own.length,
    costUsd: projectSpendUsd(project.id, tasks, chats, log?.memoryCostUsd ?? 0),
    lastActivity: log?.lastActivity ?? null,
  };
}
