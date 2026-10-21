import { useRef, useState, useSyncExternalStore } from 'react';
import type { InboxItem } from '../../core/orchestrator';
import type { WorkspaceActions } from '../../core/workspace';

type Props = { workspace: WorkspaceActions };
type InboxAction = Parameters<WorkspaceActions['resolveInbox']>[1];

function InboxRow({
  workspace,
  item,
  name,
}: Props & { item: InboxItem; name: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function resolve(action: InboxAction) {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError('');
    try {
      await workspace.resolveInbox(item.id, action);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not resolve this inbox item.',
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  return (
    <article className="agenthq-inbox-item" aria-busy={pending}>
      <strong>{name}</strong>
      <p>{item.message}</p>
      {item.path && (
        <button
          type="button"
          onClick={() => {
            void workspace
              .openNote(item.path!)
              .catch((caught: unknown) => workspace.reportError(caught));
          }}
        >
          Open note
        </button>
      )}
      <div className="agenthq-inbox-actions">
        {item.kind === 'schedule-held' ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('retry');
              }}
            >
              Resume schedule
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('dismiss');
              }}
            >
              Dismiss
            </button>
          </>
        ) : item.kind === 'verification-exhausted' && item.path ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('accept');
              }}
            >
              Accept anyway
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('retry');
              }}
            >
              Retry 2 more
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('cancel');
              }}
            >
              Cancel task
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              void resolve('dismiss');
            }}
          >
            Dismiss
          </button>
        )}
      </div>
      {pending && <p role="status">Updating task…</p>}
      {error && (
        <p className="agenthq-warning" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function InboxContent({ workspace }: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const items = (state.chat?.inbox ?? []).filter((item) => !item.resolved);
  return (
    <section className="agenthq-inbox" aria-label="Team inbox">
      <h3>Inbox ({items.length})</h3>
      {!items.length && (
        <p className="agenthq-help">No items need your attention.</p>
      )}
      {items.map((item) => (
        <InboxRow
          key={item.id}
          workspace={workspace}
          item={item}
          name={
            state.agents.find((agent) => agent.id === item.agentId)?.name ??
            item.agentId
          }
        />
      ))}
    </section>
  );
}
