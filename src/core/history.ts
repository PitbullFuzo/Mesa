import type { Agent } from './model';
import type { NoteDocument } from './notes';

/** This agent (the selected one), every agent, or one group's agents. */
export type HistoryScope = 'agent' | 'all' | `group:${string}`;

export interface HistoryRow {
  note: NoteDocument;
  agent: Agent;
  status: string;
}

function startedOf(note: NoteDocument): string {
  const started = (note.frontmatter as { started?: unknown } | null)?.started;
  return typeof started === 'string' ? started : '';
}

/** Rows for the chosen scope, newest first by start time; notes without a start time go last. */
export function historyRows(
  chats: { agent: Agent; status: string; history: NoteDocument[] }[],
  scope: HistoryScope,
  agentId: string,
): HistoryRow[] {
  return chats
    .filter((entry) => {
      if (scope === 'all') return true;
      if (scope === 'agent') return entry.agent.id === agentId;
      return entry.agent.group === scope.slice('group:'.length);
    })
    .flatMap((entry) =>
      entry.history.map((note) => ({
        note,
        agent: entry.agent,
        status: entry.status,
      })),
    )
    .sort((a, b) => startedOf(b.note).localeCompare(startedOf(a.note)));
}
