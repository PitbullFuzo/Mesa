import type { ChatSnapshot } from './chat';
import type { Project, ProjectInput } from './projects';
import type { ImageAttachment } from './images';
import type { NoteDocument } from './notes';
import type { BroadcastTarget } from './broadcast';
import type { AgentCollection, Group, Skill } from './model';
import type { AgentSetupPatch } from './setup';

export type Point = { x: number; y: number };
export type Layout = Record<string, Point>;
/** Where the Agent panel lives: the right sidebar or a main-area tab. */
export type AgentPlacement = 'side' | 'main';
export type AgentTab = 'chat' | 'setup' | 'tasks' | 'history';

export interface WorkspaceSnapshot extends AgentCollection {
  browser?: import('./browser').BrowserStatus;
  /** Microsoft 365 connector: whether an account is connected, and its name. */
  m365?: {
    connected: boolean;
    account?: string;
    /** Signed in before the profile permission was asked for: works, but one more sign-in is needed to approve it. */
    needsPermission?: boolean;
  };
  /** Note destinations from Settings, for the per-agent tick boxes in Setup. */
  noteTypes?: import('./noteTypes').NoteType[];
  tasks?: NoteDocument[];
  chat?: ChatSnapshot;
  developerMode?: boolean;
  pins?: string[];
  projects?: Project[];
  /** What each project's Log says, keyed by project id. */
  projectLogs?: Record<string, ProjectLogSummary>;
  /** Direct chat facts, for project cost. */
  projectChats?: ChatFacts[];
  /** Schedules from Obi-I/Schedules. */
  schedules?: Schedule[];
  /** Model lists read from OpenCode and Codex, keyed by runtime id. */
  runtimeModels?: Record<string, import('./models').ModelChoice[]>;
  agentPlacement?: AgentPlacement;
  enterToSend?: boolean;
  /** Obi's welcome tour: done for good, the disclaimer accepted, and hidden for this session by "Maybe later". */
  tourDone?: boolean;
  disclaimerAccepted?: boolean;
  tourDismissed?: boolean;
  /** The last setup check ("What you need"), and whether one is running. */
  setup?: import('./setupCheck').ToolCheck[];
  setupChecking?: boolean;
  /** The outside folders Settings allows; each agent's Setup ticks its own. */
  allowedFolders?: string[];
  groups: Group[];
  skills: Skill[];
  layout: Layout;
  selectedId: string | null;
  selectionRevision: number;
  agentTab: AgentTab;
  loading: boolean;
  error: string | null;
}

/** Shared UI boundary; implementations perform all persistent work through Store. */
import type {
  ChatFacts,
  ProjectLogSummary,
  ProjectStatus,
} from './projectBoard';

/** Project memory as shown on the project form. */
export interface ProjectMemoryInfo {
  model: string;
  notes: number;
  lastContextWords: number | null;
}

import type { LoopResult, LoopSpec } from './loops';
import type { Schedule, ScheduleInput } from './schedules';

/** A note the owner attached to a message. */
export interface AttachedNote {
  path: string;
  content: string;
  /** True when the note was longer than the cap and was cut. */
  truncated: boolean;
}

export interface WorkspaceActions {
  /** Creates a skill note; resolves with its path. */
  createSkill(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<string>;
  /** Edits a skill's description and instructions. */
  updateSkill(
    path: string,
    patch: { description?: string; instructions?: string },
  ): Promise<void>;
  /** Adds or removes a skill for agents and projects. */
  assignSkill(
    path: string,
    change: { agentIds: string[]; projectIds: string[]; add: boolean },
  ): Promise<void>;
  /** Removes the skill from every agent and project that uses it, then trashes its note. */
  deleteSkill(path: string): Promise<void>;
  /** The note open in the editor, for "Attach current note": null when no note is open. Content is capped. */
  currentNote(): Promise<AttachedNote | null>;
  /** Forks a conversation at a message into a new chat note; resolves with its path. */
  forkChat(agentId: string, index: number): Promise<string>;
  /** Creates a schedule note: a message sent to an agent on a rule, while Obsidian is open. */
  createSchedule(input: ScheduleInput): Promise<string>;
  /** Pauses or resumes a schedule. */
  setScheduleEnabled(path: string, enabled: boolean): Promise<void>;
  /** Runs every schedule that is due now. Called once a minute. */
  tickSchedules(): Promise<void>;
  /** Changes a schedule: agent, project, message, rule, cap and policy. */
  updateSchedule(
    path: string,
    input: Omit<ScheduleInput, 'name'>,
  ): Promise<void>;
  /** Deletes a schedule: its note goes to Obsidian's trash. */
  deleteSchedule(path: string): Promise<void>;
  /** Runs a schedule once now, without changing its regular next run. */
  runScheduleNow(path: string): Promise<void>;
  /** Resumes a held schedule. */
  resumeSchedule(path: string): Promise<void>;
  readonly getSnapshot: () => WorkspaceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  selectAgent(id: string, tab?: AgentTab): void;
  setAgentTab(tab: AgentTab): void;
  setEnterToSend(enterToSend: boolean): void;
  setPinned(id: string, pinned: boolean): Promise<void>;
  setAgentPlacement(placement: AgentPlacement): void;
  openBeside(id: string): void;
  approveProposal(agentId: string, proposalId: string): Promise<void>;
  rejectProposal(agentId: string, proposalId: string): void;
  /** Approve or reject one command card (Run commands: Ask me each time). */
  resolveCommand(agentId: string, cardId: string, approved: boolean): void;
  restoreObi(): Promise<void>;
  setTourState(tourDone: boolean, disclaimerAccepted: boolean): void;
  /** Runs the setup check and keeps the result in the snapshot; a failed check is reported. */
  runSetupCheck(): Promise<void>;
  /** "Re-run safety check": clears the stored safety results, then runs the setup check again. */
  rerunSafetyCheck(): Promise<void>;
  setAllowedFolders(folders: string[]): void;
  /** "Maybe later": hides the tour for this session only; it asks again next start. */
  dismissTour(): void;
  /** Finishes the tour and the disclaimer; both are saved for good. */
  finishTour(): Promise<void>;
  /** "Take the tour again". */
  restartTour(): void;
  /** Whether the Obi-I folder is in Obsidian's Excluded files (hidden from search and the graph). */
  agentFolderHidden(): boolean;
  /** The tour's "Hide it" button: adds or removes the Obi-I folder in Excluded files. */
  setAgentFolderHidden(hide: boolean): void;
  loadRuntimeModels(runtime: string): Promise<void>;
  requestCreateAgent(): void;
  requestCreateGroup(): void;
  createAgent(name: string): Promise<string>;
  createGroup(name: string, color: string): Promise<string>;
  updateAgent(id: string, patch: AgentSetupPatch): Promise<void>;
  setManager(id: string, managerId: string | null): Promise<void>;
  moveAgent(id: string, position: Point): Promise<void>;
  moveGroup(id: string, position: Point): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  openNote(path: string): Promise<void>;
  saveImage(file: File): Promise<ImageAttachment>;
  sendMessage(
    id: string,
    text: string,
    images?: ImageAttachment[],
    projectId?: string,
  ): Promise<void>;
  broadcast(
    target: BroadcastTarget,
    text: string,
    images?: ImageAttachment[],
    projectId?: string,
  ): Promise<void>;
  saveProject(input: ProjectInput): Promise<string>;
  archiveProject(path: string): Promise<void>;
  /** Moves the project note to Obsidian's trash. Refused while a request in the project is running. */
  deleteProject(path: string): Promise<void>;
  projectMemoryInfo(path: string): Promise<ProjectMemoryInfo>;
  /** Sets a project's status, as a drag on the board does. */
  setProjectStatus(path: string, status: ProjectStatus): Promise<void>;
  /** Archives a project (hidden from pickers) or brings it back. */
  setProjectArchived(path: string, archived: boolean): Promise<void>;
  /** Runs a 🔁 loop in an agent chat; resolves when the loop ends. */
  startLoop(
    agentId: string,
    spec: LoopSpec,
    message: string,
    projectId?: string,
  ): Promise<LoopResult>;
  /** Reloads agents, groups, skills, tasks and projects from the vault. */
  refresh(): Promise<void>;
  stopAgent(id: string): Promise<void>;
  resolveInbox(
    id: string,
    action: 'accept' | 'retry' | 'cancel' | 'dismiss',
  ): Promise<void>;
  stopAll(): Promise<void>;
  newConversation(id: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  deleteAgentHistory(id: string): Promise<void>;
  deleteChatNotes(id: string | null, paths: string[]): Promise<void>;
  deleteGroupHistory(groupId: string): Promise<void>;
  continueChat(id: string, path: string): Promise<void>;
  renameChat(id: string, path: string, current: string): Promise<void>;
  deleteAllHistory(): Promise<void>;
  reportError(error: unknown): void;
}
