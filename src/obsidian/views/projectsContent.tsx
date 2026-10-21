import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  projectAssignmentLabel,
  PROJECT_STATUSES,
  type Project,
} from '../../core/projects';
import {
  BOARD_COLUMNS,
  TASK_COLUMNS,
  projectStats,
  taskColumnOf,
  taskFacts,
  type ProjectStats,
  type ProjectStatus,
  type TaskFacts,
} from '../../core/projectBoard';
import type { WorkspaceActions } from '../../core/workspace';
import type { Schedule } from '../../core/schedules';
import { ScheduleRowActions } from './schedulesContent';

type Props = {
  workspace: WorkspaceActions;
  openForm: (existing: Project | null) => void;
  /** Asks before a project is marked done; resolves true when the owner confirms. */
  confirmDone: (project: Project) => Promise<boolean>;
  /** Opens the schedule form; a project page passes its project. */
  openSchedule: (existing: Schedule | null, projectId?: string) => void;
  confirmDelete: (schedule: Schedule) => Promise<boolean>;
};
type SortKey = 'name' | 'status' | 'progress' | 'cost' | 'activity';
type PageTab = 'overview' | 'tasks' | 'context' | 'schedules' | 'settings';
const PAGE_TABS: { id: PageTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'context', label: 'Context' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'settings', label: 'Settings' },
];

const label = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const money = (usd: number) => `$${usd.toFixed(4)}`;
const activityText = (stats: ProjectStats) =>
  stats.lastActivity
    ? `last activity ${stats.lastActivity.slice(0, 16).replace('T', ' ')}`
    : 'no activity yet';

/** The Projects page: a board or a sortable list, and a project page for one project. */
export function ProjectsContent({
  workspace,
  openForm,
  confirmDone,
  openSchedule,
  confirmDelete,
}: Props) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );
  const [view, setView] = useState<'board' | 'list'>('board');
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: 'name',
    ascending: true,
  });
  // Opening the page reads the latest notes, so counts and the Log are current.
  useEffect(() => {
    void workspace.refresh();
  }, [workspace]);
  const tasks: TaskFacts[] = (state.chat?.tasks ?? state.tasks ?? []).map(
    taskFacts,
  );
  // The earliest enabled run of a project's schedules: the 🔁 badge. Hidden when there are none.
  const nextRunOf = (project: Project): string | null => {
    const runs = (state.schedules ?? [])
      .filter(
        (entry) =>
          entry.projectId === project.id && entry.enabled && entry.nextRun,
      )
      .map((entry) => entry.nextRun!)
      .sort();
    return runs[0] ? runs[0].slice(0, 16).replace('T', ' ') : null;
  };
  const statsOf = (project: Project) =>
    projectStats(
      project,
      tasks,
      state.projectChats ?? [],
      state.projectLogs?.[project.id],
    );
  const assignedOf = (project: Project) =>
    projectAssignmentLabel(project, state.agents, state.groups);
  const projects = (state.projects ?? []).filter(
    (project) =>
      (showArchived || !project.archived) &&
      project.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const open = state.projects?.find((project) => project.path === openPath);

  async function unarchive(path: string) {
    try {
      await workspace.setProjectArchived(path, false);
    } catch (error) {
      workspace.reportError(error);
    }
  }

  async function drop(path: string, status: ProjectStatus) {
    const project = state.projects?.find((entry) => entry.path === path);
    if (!project || project.status === status) return;
    if (status === 'done' && !(await confirmDone(project))) return;
    try {
      await workspace.setProjectStatus(path, status);
    } catch (error) {
      workspace.reportError(error);
    }
  }

  if (open)
    return (
      <ProjectPage
        project={open}
        stats={statsOf(open)}
        tasks={tasks.filter((task) => task.projectId === open.id)}
        logTail={state.projectLogs?.[open.id]?.tail ?? []}
        assigned={assignedOf(open)}
        openForm={openForm}
        schedules={(state.schedules ?? []).filter(
          (entry) => entry.projectId === open.id,
        )}
        workspace={workspace}
        openSchedule={(existing) => openSchedule(existing, open.id)}
        confirmDelete={confirmDelete}
        onBack={() => setOpenPath(null)}
      />
    );

  return (
    <div className="agenthq-projects">
      <header className="agenthq-projects-header">
        <h3>Projects</h3>
        <div>
          <button
            aria-pressed={view === 'board'}
            onClick={() => setView('board')}
          >
            Board
          </button>{' '}
          <button
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </button>{' '}
          <button className="mod-cta" onClick={() => openForm(null)}>
            + Project
          </button>
        </div>
      </header>
      <div className="agenthq-projects-filter">
        <input
          type="search"
          placeholder="Search projects"
          aria-label="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{' '}
          Show archived
        </label>
      </div>
      {(state.projects ?? []).length === 0 && (
        <p className="agenthq-projects-empty">
          No projects yet. Choose + Project to create one.
        </p>
      )}
      {view === 'board' ? (
        <div className="agenthq-board">
          {BOARD_COLUMNS.map((status) => {
            const inColumn = projects.filter(
              (project) => project.status === status,
            );
            return (
              <section
                key={status}
                className="agenthq-board-column"
                aria-label={label(status)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void drop(event.dataTransfer.getData('text/plain'), status);
                }}
              >
                <h4>
                  {label(status)} <small>{inColumn.length}</small>
                </h4>
                {inColumn.map((project) => {
                  const stats = statsOf(project);
                  return (
                    <div key={project.id} className="agenthq-card-wrap">
                      <button
                        className="agenthq-card"
                        draggable
                        onDragStart={(event) =>
                          event.dataTransfer.setData('text/plain', project.path)
                        }
                        onClick={() => setOpenPath(project.path)}
                      >
                        <strong>{project.name}</strong>
                        {project.goal && (
                          <span className="agenthq-project-goal">
                            {project.goal}
                          </span>
                        )}
                        <small>{assignedOf(project)}</small>
                        <Progress value={stats.progress} />
                        <small>
                          {stats.done}/{stats.total} tasks ·{' '}
                          {money(stats.costUsd)} · {activityText(stats)}
                        </small>
                        {nextRunOf(project) && (
                          <small>🔁 next {nextRunOf(project)}</small>
                        )}
                      </button>
                      {project.archived && (
                        <button onClick={() => void unarchive(project.path)}>
                          Unarchive
                        </button>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : (
        <ProjectTable
          projects={projects}
          statsOf={statsOf}
          sort={sort}
          onSort={(key) =>
            setSort((current) => ({
              key,
              ascending: current.key === key ? !current.ascending : true,
            }))
          }
          onOpen={setOpenPath}
          onUnarchive={(path) => void unarchive(path)}
        />
      )}
    </div>
  );
}

function Progress({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span
      className="agenthq-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

function ProjectTable({
  projects,
  statsOf,
  sort,
  onSort,
  onOpen,
  onUnarchive,
}: {
  projects: Project[];
  statsOf: (project: Project) => ProjectStats;
  sort: { key: SortKey; ascending: boolean };
  onSort: (key: SortKey) => void;
  onOpen: (path: string) => void;
  onUnarchive: (path: string) => void;
}) {
  const value = (project: Project, key: SortKey): string | number => {
    const stats = statsOf(project);
    switch (key) {
      case 'name':
        return project.name;
      case 'status':
        return PROJECT_STATUSES.indexOf(project.status);
      case 'progress':
        return stats.progress;
      case 'cost':
        return stats.costUsd;
      case 'activity':
        return stats.lastActivity ?? '';
    }
  };
  const sorted = [...projects].sort((a, b) => {
    const left = value(a, sort.key);
    const right = value(b, sort.key);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return sort.ascending ? order : -order;
  });
  const headers: { key: SortKey; text: string }[] = [
    { key: 'name', text: 'Name' },
    { key: 'status', text: 'Status' },
    { key: 'progress', text: 'Progress' },
    { key: 'cost', text: 'Cost' },
    { key: 'activity', text: 'Last activity' },
  ];
  return (
    <table className="agenthq-project-table">
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header.key}>
              <button onClick={() => onSort(header.key)}>
                {header.text}
                {sort.key === header.key ? (sort.ascending ? ' ▲' : ' ▼') : ''}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((project) => {
          const stats = statsOf(project);
          return (
            <tr key={project.id}>
              <td>
                <button onClick={() => onOpen(project.path)}>
                  {project.name}
                </button>
                {project.archived && (
                  <button onClick={() => onUnarchive(project.path)}>
                    Unarchive
                  </button>
                )}
              </td>
              <td>{label(project.status)}</td>
              <td>
                {stats.done}/{stats.total}
              </td>
              <td>{money(stats.costUsd)}</td>
              <td>
                {stats.lastActivity?.slice(0, 16).replace('T', ' ') ?? '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectPage({
  project,
  stats,
  tasks,
  logTail,
  assigned,
  openForm,
  schedules,
  workspace,
  openSchedule,
  confirmDelete,
  onBack,
}: {
  project: Project;
  stats: ProjectStats;
  tasks: TaskFacts[];
  logTail: string[];
  assigned: string;
  openForm: (existing: Project | null) => void;
  schedules: Schedule[];
  workspace: WorkspaceActions;
  openSchedule: (existing: Schedule | null) => void;
  confirmDelete: (schedule: Schedule) => Promise<boolean>;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<PageTab>('overview');
  return (
    <div className="agenthq-projects">
      <header className="agenthq-projects-header">
        <button onClick={onBack}>← Projects</button>
        <h3>{project.name}</h3>
        <button onClick={() => openForm(project)}>Edit</button>
      </header>
      <nav className="agenthq-tabs" role="tablist">
        {PAGE_TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && (
        <div>
          <p>
            <strong>{label(project.status)}</strong>
            {project.goal ? ` · ${project.goal}` : ''}
          </p>
          <p>{assigned}</p>
          <Progress value={stats.progress} />
          <p>
            {stats.done}/{stats.total} tasks done · cost to date{' '}
            {money(stats.costUsd)} · {activityText(stats)}
          </p>
        </div>
      )}
      {tab === 'tasks' && (
        <div className="agenthq-board">
          {TASK_COLUMNS.map((column) => (
            <section
              key={column.id}
              className="agenthq-board-column"
              aria-label={column.label}
            >
              <h4>
                {column.label}{' '}
                <small>
                  {
                    tasks.filter(
                      (task) => taskColumnOf(task.status) === column.id,
                    ).length
                  }
                </small>
              </h4>
              {tasks
                .filter((task) => taskColumnOf(task.status) === column.id)
                .map((task) => (
                  <div key={task.name} className="agenthq-card">
                    <strong>{task.name}</strong>
                    <small>{task.status}</small>
                  </div>
                ))}
            </section>
          ))}
        </div>
      )}
      {tab === 'context' && (
        <div>
          <h4>Brief</h4>
          <pre className="agenthq-context">
            {project.instructions || 'No brief yet.'}
          </pre>
          <h4>Recent log</h4>
          <pre className="agenthq-context">
            {logTail.join('\n') || 'No log yet.'}
          </pre>
          <button onClick={() => openForm(project)}>Edit brief</button>
        </div>
      )}
      {tab === 'schedules' && (
        <div>
          <button onClick={() => openSchedule(null)}>+ Schedule</button>
          {schedules.length === 0 && (
            <p className="agenthq-projects-empty">
              No schedules for this project yet. Runs happen only while Obsidian
              is open.
            </p>
          )}
          <ul className="agenthq-schedule-list">
            {schedules.map((entry) => (
              <li key={entry.path} className="agenthq-schedule-row">
                <strong>{entry.name}</strong>
                <span className="agenthq-schedule-message">
                  {entry.message.slice(0, 120)}
                </span>
                <ScheduleRowActions
                  schedule={entry}
                  workspace={workspace}
                  onEdit={openSchedule}
                  confirmDelete={confirmDelete}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'settings' && (
        <div>
          <p>
            Instructions, skills, teams, agents, context levels, memory model
            and cost limit.
          </p>
          <button onClick={() => openForm(project)}>Open settings</button>
        </div>
      )}
    </div>
  );
}
