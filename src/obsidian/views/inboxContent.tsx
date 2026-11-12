import { useRef, useState, useSyncExternalStore } from 'react';
import { t } from '../../core/i18n';
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
        caught instanceof Error ? caught.message : t('inbox.couldNotResolve'),
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
          {t('inbox.openNote')}
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
              {t('inbox.resumeSchedule')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('dismiss');
              }}
            >
              {t('btn.dismiss')}
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
              {t('inbox.acceptAnyway')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('retry');
              }}
            >
              {t('inbox.retry2')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                void resolve('cancel');
              }}
            >
              {t('inbox.cancelTask')}
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
            {t('btn.dismiss')}
          </button>
        )}
      </div>
      {pending && <p role="status">{t('inbox.updating')}</p>}
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
    <section className="agenthq-inbox" aria-label={t('inbox.label')}>
      <h3>{t('inbox.title', { n: items.length })}</h3>
      {!items.length && <p className="agenthq-help">{t('inbox.empty')}</p>}
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
