import { useSyncExternalStore } from 'react';
import type { WorkspaceActions } from '../../core/workspace';

export function TasksContent({
  workspace,
  id,
}: {
  workspace: WorkspaceActions;
  id: string;
}) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const tasks = (state.tasks ?? []).filter((note) => {
    const fm = note.frontmatter;
    return (
      fm !== null && typeof fm === 'object' && 'toId' in fm && fm.toId === id
    );
  });
  return (
    <section className="agenthq-tasks" aria-label="Agent tasks">
      {!tasks.length && <p>No tasks for this agent yet.</p>}
      {tasks.map((note) => {
        const fm = note.frontmatter as Record<string, unknown>;
        return (
          <article className="agenthq-chat-message" key={note.path}>
            <button
              onClick={() => {
                void workspace
                  .openNote(note.path)
                  .catch((error: unknown) => workspace.reportError(error));
              }}
            >
              {note.name}
            </button>
            <p>
              Status: {typeof fm.status === 'string' ? fm.status : 'unknown'}
            </p>
            <p>
              Attempt {typeof fm.attempt === 'number' ? fm.attempt : 0} /{' '}
              {typeof fm.maxAttempts === 'number' ? fm.maxAttempts : 1}
            </p>
            <p>
              Verdict:{' '}
              {typeof fm.verdict === 'string' ? fm.verdict : 'No verification'}
            </p>
          </article>
        );
      })}
    </section>
  );
}
