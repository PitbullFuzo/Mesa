import {
  ItemView,
  type App,
  type ViewStateResult,
  type WorkspaceLeaf,
} from 'obsidian';
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceActions } from '../../core/workspace';
import {
  AgentPanelContent,
  AgentTabContent,
  TeamPanelContent,
} from './panelContent';
import { ProjectsContent } from './projectsContent';
import { SchedulesContent } from './schedulesContent';
import { SkillsContent } from './skillsContent';
import { openAssignSkill, openSkillForm } from '../skillModal';
import { skillUsers } from '../../core/skills';
import type { Skill } from '../../core/model';
import { openScheduleForm } from '../scheduleForm';
import type { Schedule } from '../../core/schedules';
import { confirmAction } from '../modals';
import type { Project } from '../../core/projects';
import { agentTabTitle, tabState } from '../../core/tabs';
import type { AgentPlacement, AgentTab } from '../../core/workspace';

export const AGENT_VIEW = 'agenthq-agent';
export const TEAM_VIEW = 'agenthq-team';
export const PROJECTS_VIEW = 'agenthq-projects';
export const SCHEDULES_VIEW = 'agenthq-schedules';
export const SKILLS_VIEW = 'agenthq-skills';

abstract class ReactPanel extends ItemView {
  private root: Root | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    protected readonly workspace: WorkspaceActions,
  ) {
    super(leaf);
  }
  protected abstract content(): ReactElement;

  onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('agenthq-panel');
    this.root = createRoot(this.contentEl);
    this.root.render(this.content());
    this.register(() => this.unmount());
    return Promise.resolve();
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
  protected refresh(): void {
    this.root?.render(this.content());
  }
  onClose(): Promise<void> {
    this.unmount();
    return Promise.resolve();
  }
}

/** One Agent tab. Its agent and tab live in the leaf's view state, so Obsidian restores them on reload. */
export class AgentPanel extends ReactPanel {
  private tab: { agentId: string; tab: AgentTab } | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    workspace: WorkspaceActions,
    private readonly moveLeaf: (
      leaf: WorkspaceLeaf,
      target: AgentPlacement,
    ) => Promise<void>,
  ) {
    super(leaf, workspace);
  }
  /** Where this view sits: the side panel, a main-area tab, or a pop-out window. */
  private location(): 'side' | 'main' | 'window' {
    const root = this.leaf.getRoot();
    if (root === this.app.workspace.rightSplit) return 'side';
    if (root === this.app.workspace.rootSplit) return 'main';
    return 'window';
  }
  getViewType(): string {
    return AGENT_VIEW;
  }
  getDisplayText(): string {
    return agentTabTitle(this.boundAgent());
  }
  /** The agent this view shows; a view with no agent yet shows the shared selection. */
  private boundAgent() {
    const snapshot = this.workspace.getSnapshot();
    const agentId = this.tab?.agentId ?? snapshot.selectedId;
    return snapshot.agents.find((agent) => agent.id === agentId);
  }
  private shownTitle = '';
  async onOpen(): Promise<void> {
    await super.onOpen();
    // Obsidian keeps tab titles in its header; refresh it only when the bound agent's title changes.
    const unsubscribe = this.workspace.subscribe(() => this.refreshTitle());
    this.register(unsubscribe);
    this.refreshTitle();
  }
  private refreshTitle(): void {
    const title = this.getDisplayText();
    if (title === this.shownTitle) return;
    this.shownTitle = title;
    // Not in Obsidian's public typings; used only to repaint the tab title.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }
  getIcon(): string {
    return 'bot';
  }
  getState(): Record<string, unknown> {
    return this.tab ? { ...this.tab } : {};
  }
  setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.tab = tabState(state);
    this.refresh();
    this.refreshTitle();
    return super.setState(state, result);
  }
  protected content(): ReactElement {
    // A new tab opened without an agent shows the shared selection, and binds to it.
    this.tab ??= this.workspace.getSnapshot().selectedId
      ? { agentId: this.workspace.getSnapshot().selectedId!, tab: 'chat' }
      : null;
    if (!this.tab)
      return createElement(AgentPanelContent, {
        workspace: this.workspace,
        app: this.app,
      });
    return createElement(AgentTabContent, {
      workspace: this.workspace,
      app: this.app,
      agentId: this.tab.agentId,
      tab: this.tab.tab,
      onState: (value) => {
        this.tab = value;
      },
      onMissing: () => this.leaf.detach(),
      location: this.location(),
      onMove: (target) => {
        void this.moveLeaf(this.leaf, target);
      },
      // Close is offered only in the side panel; a window or tab closes with its own close control.
      onClose:
        this.location() === 'side' ? () => this.leaf.detach() : undefined,
    });
  }
}

export class TeamPanel extends ReactPanel {
  getViewType(): string {
    return TEAM_VIEW;
  }
  getDisplayText(): string {
    return 'Team';
  }
  getIcon(): string {
    return 'users';
  }
  protected content(): ReactElement {
    return createElement(TeamPanelContent, { workspace: this.workspace });
  }
}

/** The Projects page: the project list, which the Step 19 board will replace. */
export class ProjectsPanel extends ReactPanel {
  constructor(
    leaf: WorkspaceLeaf,
    workspace: WorkspaceActions,
    private readonly openForm: (existing: Project | null) => void,
  ) {
    super(leaf, workspace);
  }
  getViewType(): string {
    return PROJECTS_VIEW;
  }
  getDisplayText(): string {
    return 'Projects';
  }
  getIcon(): string {
    return 'folder-kanban';
  }
  protected content(): ReactElement {
    return createElement(ProjectsContent, {
      workspace: this.workspace,
      openForm: this.openForm,
      confirmDone: (project: Project) =>
        confirmAction(
          this.app,
          `Mark ${project.name} as done?`,
          'It moves to the Done column. You can move it back at any time.',
        ),
      openSchedule: (existing: Schedule | null, projectId?: string) =>
        openScheduleForm(this.app, this.workspace, { existing, projectId }),
      confirmDelete: (schedule: Schedule) =>
        confirmDeleteSchedule(this.app, schedule),
    });
  }
}

/** The Schedules page: every schedule, with filters, + Schedule, and the row actions. */
export class SchedulesPanel extends ReactPanel {
  constructor(leaf: WorkspaceLeaf, workspace: WorkspaceActions) {
    super(leaf, workspace);
  }
  getViewType(): string {
    return SCHEDULES_VIEW;
  }
  getDisplayText(): string {
    return 'Schedules';
  }
  getIcon(): string {
    return 'calendar-clock';
  }
  protected content(): ReactElement {
    return createElement(SchedulesContent, {
      workspace: this.workspace,
      openSchedule: (existing: Schedule | null) =>
        openScheduleForm(this.app, this.workspace, { existing }),
      confirmDelete: (schedule: Schedule) =>
        confirmDeleteSchedule(this.app, schedule),
    });
  }
}

function confirmDeleteSchedule(app: App, schedule: Schedule): Promise<boolean> {
  return confirmAction(
    app,
    `Delete schedule ${schedule.name}?`,
    "The schedule note is moved to Obsidian's trash and can be restored. Chats keep their history.",
  );
}

/** The Skills page: every skill, with size, use, and create, assign, edit, delete and import. */
export class SkillsPanel extends ReactPanel {
  constructor(
    leaf: WorkspaceLeaf,
    workspace: WorkspaceActions,
    private readonly importSkills: () => Promise<void>,
  ) {
    super(leaf, workspace);
  }
  getViewType(): string {
    return SKILLS_VIEW;
  }
  getDisplayText(): string {
    return 'Skills';
  }
  getIcon(): string {
    return 'book-open';
  }
  protected content(): ReactElement {
    return createElement(SkillsContent, {
      workspace: this.workspace,
      openCreate: () => openSkillForm(this.app, this.workspace),
      openAssign: (skill: Skill) =>
        openAssignSkill(this.app, this.workspace, skill),
      confirmDelete: (skill: Skill) => {
        const snapshot = this.workspace.getSnapshot();
        const users = skillUsers(
          skill,
          snapshot.agents,
          snapshot.projects ?? [],
        );
        const losing = [
          ...users.agents.map((agent) => agent.name),
          ...users.projects.map((project) => `project ${project.name}`),
        ];
        return confirmAction(
          this.app,
          `Delete skill ${skill.name}?`,
          `It is removed from ${losing.length ? losing.join(', ') : 'no one (nothing uses it)'}. The note is moved to Obsidian's trash and can be restored.`,
        );
      },
      importSkills: this.importSkills,
    });
  }
}
