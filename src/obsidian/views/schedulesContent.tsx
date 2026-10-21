import { useEffect, useState, useSyncExternalStore } from 'react';
import { describeRule, nextRunText, type Schedule } from '../../core/schedules';
import type { WorkspaceActions } from '../../core/workspace';

/** Pause/Resume, Run now, Edit and Delete for one schedule row. Shared by the Schedules page and the project page. */
export function ScheduleRowActions({
  schedule,
  workspace,
  onEdit,
  confirmDelete,
}: {
  schedule: Schedule;
  workspace: WorkspaceActions;
  onEdit: (schedule: Schedule) => void;
  confirmDelete: (schedule: Schedule) => Promise<boolean>;
}) {
  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      workspace.reportError(error);
    }
  }
  return (
    <span className="agenthq-schedule-actions">
      <button onClick={() => onEdit(schedule)}>Edit</button>
      <button
        onClick={() => void run(() => workspace.runScheduleNow(schedule.path))}
      >
        Run now
      </button>
      {schedule.held || !schedule.enabled ? (
        <button
          onClick={() =>
            void run(() =>
              schedule.held
                ? workspace.resumeSchedule(schedule.path)
                : workspace.setScheduleEnabled(schedule.path, true),
            )
          }
        >
          Resume
        </button>
      ) : (
        <button
          onClick={() =>
            void run(() => workspace.setScheduleEnabled(schedule.path, false))
          }
        >
          Pause
        </button>
      )}
      <button
        className="mod-warning"
        onClick={() =>
          void run(async () => {
            if (await confirmDelete(schedule))
              await workspace.deleteSchedule(schedule.path);
          })
        }
      >
        Delete
      </button>
    </span>
  );
}

type Props = {
  workspace: WorkspaceActions;
  openSchedule: (existing: Schedule | null) => void;
  confirmDelete: (schedule: Schedule) => Promise<boolean>;
};

/** Every schedule, with filters. The next run is in local time, with how far away it is. */
export function SchedulesContent({
  workspace,
  openSchedule,
  confirmDelete,
}: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [projectFilter, setProjectFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'enabled' | 'paused' | 'held'
  >('all');
  // Opening the page reads the latest notes, so next runs and last statuses are current.
  useEffect(() => {
    void workspace.refresh();
  }, [workspace]);
  const now = new Date();
  const schedules = (state.schedules ?? []).filter((entry) => {
    if (projectFilter === 'none' && entry.projectId) return false;
    if (
      projectFilter &&
      projectFilter !== 'none' &&
      entry.projectId !== projectFilter
    )
      return false;
    if (agentFilter && entry.agentId !== agentFilter) return false;
    if (statusFilter === 'enabled') return entry.enabled && !entry.held;
    if (statusFilter === 'paused') return !entry.enabled;
    if (statusFilter === 'held') return entry.held;
    return true;
  });
  const projectName = (id?: string) =>
    id
      ? ((state.projects ?? []).find((project) => project.id === id)?.name ??
        '(deleted project)')
      : 'No project';
  const agentName = (id: string) =>
    state.agents.find((agent) => agent.id === id)?.name ?? id;
  return (
    <div className="agenthq-projects">
      <header className="agenthq-projects-header">
        <h3>Schedules</h3>
        <button className="mod-cta" onClick={() => openSchedule(null)}>
          + Schedule
        </button>
      </header>
      <div className="agenthq-projects-filter">
        <label>
          Project{' '}
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">All projects</option>
            <option value="none">No project</option>
            {(state.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent{' '}
          <select
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
          >
            <option value="">All agents</option>
            {state.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{' '}
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as typeof statusFilter)
            }
          >
            <option value="all">All</option>
            <option value="enabled">Enabled</option>
            <option value="paused">Paused</option>
            <option value="held">Held by cost cap</option>
          </select>
        </label>
      </div>
      {schedules.length === 0 ? (
        <p className="agenthq-projects-empty">
          No schedules match. Choose + Schedule to create one. Schedules run
          only while Obsidian is open.
        </p>
      ) : (
        <ul className="agenthq-schedule-list">
          {schedules.map((entry) => (
            <li key={entry.path} className="agenthq-schedule-row">
              <strong>{entry.name}</strong>{' '}
              <small>
                {agentName(entry.agentId)} · {projectName(entry.projectId)} ·{' '}
                {describeRule(entry.rule)}
              </small>
              <span className="agenthq-schedule-message">
                {entry.message.slice(0, 120)}
              </span>
              <small>
                Next: {nextRunText(entry, now)}
                {entry.lastRun
                  ? ` · last: ${entry.lastRun.slice(0, 16).replace('T', ' ')} ${entry.lastStatus ?? ''}`
                  : ''}
              </small>
              <ScheduleRowActions
                schedule={entry}
                workspace={workspace}
                onEdit={openSchedule}
                confirmDelete={confirmDelete}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
