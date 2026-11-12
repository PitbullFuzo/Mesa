import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  elapsed,
  liveRows,
  liveSummary,
  statusLabel,
} from '../../core/liveActivity';
import { t } from '../../core/i18n';
import { formatSpend, type CostSummary } from '../../core/costs';
import type { WorkspaceActions } from '../../core/workspace';
import { StopAllButton } from './stopAllButton';

type Props = {
  workspace: WorkspaceActions;
  /** The latest Activity note lines, newest first. */
  loadRecent: () => Promise<string[]>;
  /** Spending from the chat and task notes, or null before Mesa has loaded. */
  loadCosts: () => Promise<CostSummary | null>;
  openActivityNote: () => void;
};

/** Live activity: what every agent is doing right now, its latest step, and the latest Activity lines. */
export function ActivityContent({
  workspace,
  loadRecent,
  loadCosts,
  openActivityNote,
}: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const rows = liveRows(state.chat?.agents ?? {}, state.chat?.loops);
  const busy = rows.some(
    (row) => row.status === 'working' || row.status === 'queued',
  );
  const [now, setNow] = useState(() => new Date());
  const [recent, setRecent] = useState<string[]>([]);
  const [costs, setCosts] = useState<CostSummary | null>(null);
  const [showIdle, setShowIdle] = useState(true);

  // A clock for "for 2 min" while something runs.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  // The Activity note changes when work finishes: re-read it when statuses change, and every 15 s.
  const statusKey = rows.map((row) => `${row.id}:${row.status}`).join(',');
  useEffect(() => {
    let live = true;
    const read = () =>
      void loadRecent()
        .then((lines) => {
          if (live) setRecent(lines);
        })
        .catch(() => {});
    read();
    const timer = window.setInterval(read, 15000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [loadRecent, statusKey]);

  // Spending changes when a reply finishes, so read it again when the page opens and when work starts or stops.
  useEffect(() => {
    let live = true;
    void loadCosts()
      .then((summary) => {
        if (live) setCosts(summary);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [loadCosts, busy]);

  const agentName = (id: string) =>
    state.agents.find((agent) => agent.id === id)?.name ??
    t('costs.removedAgent');

  const shown = showIdle
    ? rows
    : rows.filter((row) => row.status !== 'idle' && row.status !== 'offline');
  const queue = state.chat?.queue;

  return (
    <div className="agenthq-activity">
      <div className="agenthq-activity-header">
        <div>
          <h2>{t('page.activity')}</h2>
          <p className="agenthq-activity-summary">
            {liveSummary(rows)}
            {queue && queue.queued > 0
              ? t('live.queue', {
                  running: queue.running,
                  queued: queue.queued,
                })
              : ''}
          </p>
        </div>
        <span className="agenthq-activity-tools">
          <label>
            <input
              type="checkbox"
              checked={showIdle}
              onChange={(event) => setShowIdle(event.target.checked)}
            />{' '}
            {t('live.showIdle')}
          </label>
          <StopAllButton workspace={workspace} />
        </span>
      </div>

      {!state.chat ? (
        <p className="agenthq-empty">{t('live.loading')}</p>
      ) : shown.length === 0 ? (
        <p className="agenthq-empty">
          {rows.length ? t('live.allIdle') : t('live.noAgents')}
        </p>
      ) : (
        <ul className="agenthq-activity-list">
          {shown.map((row) => (
            <li
              key={row.id}
              className={`agenthq-activity-row is-${row.status}`}
            >
              <div className="agenthq-activity-top">
                <strong>{row.name}</strong>
                <span className={`agenthq-activity-status is-${row.status}`}>
                  {statusLabel(row.status)}
                  {row.loop
                    ? t('live.round', {
                        round: row.loop.round,
                        rounds: row.loop.rounds,
                      })
                    : ''}
                  {row.status === 'working' && row.since
                    ? ` · ${elapsed(row.since, now)}`
                    : ''}
                </span>
                <span className="agenthq-activity-actions">
                  <button onClick={() => workspace.selectAgent(row.id, 'chat')}>
                    {t('btn.openChat')}
                  </button>
                  {(row.status === 'working' || row.status === 'queued') && (
                    <button
                      className="mod-warning"
                      onClick={() =>
                        void workspace
                          .stopAgent(row.id)
                          .catch((error: unknown) =>
                            workspace.reportError(error),
                          )
                      }
                    >
                      {t('btn.stop')}
                    </button>
                  )}
                </span>
              </div>
              {row.doing && (
                <div className="agenthq-activity-doing">
                  {row.status === 'idle' ? t('live.lastAsked') : t('live.on')}
                  {row.doing}
                </div>
              )}
              {row.lastStep && (
                <div className="agenthq-activity-step">
                  {row.status === 'working'
                    ? t('live.now')
                    : t('live.lastStep')}
                  {row.lastStep}
                  {row.steps > 1 ? t('live.steps', { n: row.steps }) : ''}
                </div>
              )}
              {row.status === 'working' && !row.lastStep && (
                <div className="agenthq-activity-step">
                  {t('live.thinking')}
                </div>
              )}
              {row.hint && row.status !== 'idle' && (
                <div className="agenthq-activity-hint">{row.hint}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="agenthq-activity-header">
        <h3>{t('costs.title')}</h3>
      </div>
      {costs ? (
        <>
          <ul className="agenthq-activity-costs">
            <li>
              <span>{t('costs.today')}</span>{' '}
              <strong>{formatSpend(costs.today)}</strong>
            </li>
            <li>
              <span>{t('costs.week')}</span>{' '}
              <strong>{formatSpend(costs.last7Days)}</strong>
            </li>
            <li>
              <span>{t('costs.month')}</span>{' '}
              <strong>{formatSpend(costs.thisMonth)}</strong>
            </li>
          </ul>
          {costs.agents.length ? (
            <ul className="agenthq-activity-recent">
              {costs.agents.map((agent) => (
                <li key={agent.agentId}>
                  {t('costs.agentMonth', {
                    name: agentName(agent.agentId),
                    spend: formatSpend(agent),
                  })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="agenthq-empty">{t('costs.none')}</p>
          )}
          <p className="agenthq-empty">{t('costs.note')}</p>
        </>
      ) : (
        <p className="agenthq-empty">{t('costs.loading')}</p>
      )}

      <div className="agenthq-activity-header">
        <h3>{t('live.recent')}</h3>
        <button onClick={openActivityNote}>{t('live.openNote')}</button>
      </div>
      {recent.length ? (
        <ul className="agenthq-activity-recent">
          {recent.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="agenthq-empty">{t('live.nothingLogged')}</p>
      )}
    </div>
  );
}
