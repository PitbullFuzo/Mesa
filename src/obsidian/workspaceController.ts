import { Notice, FileSystemAdapter, type App } from 'obsidian';
import { imageMessage, type ImageAttachment } from '../core/images';
import { saveImageAttachment } from './images';
import type { BroadcastTarget } from '../core/broadcast';
import { graphLayoutPositions } from '../core/graphLayout';
import type { AgentSetupPatch } from '../core/setup';
import type { Store } from '../core/store';
import type { Skill } from '../core/model';
import { ensureFolder, outputFolderProblem } from '../core/folders';
import type { ToolCheck } from '../core/setupCheck';
import {
  assignSkill as assignSkillTo,
  createSkillNote,
  deleteSkill as deleteSkillNote,
  updateSkillNote,
} from '../core/skills';
import { runtimeReadWarning } from '../core/runtimes/ids';
import {
  browserUnavailableReason,
  BROWSER_CODEX_WARNING,
  BROWSER_WARNING,
  type BrowserStatus,
} from '../core/browser';
import { NOTE_ATTACH_LIMIT } from '../core/composer';
import { chatMention, conversationTitle, type ChatService } from '../core/chat';
import {
  folderListing,
  rankMentions,
  type MentionCandidate,
} from '../core/mentions';
import type {
  AttachedNote,
  AgentPlacement,
  AgentTab,
  Layout,
  Point,
  ProjectMemoryInfo,
  WorkspaceActions,
  WorkspaceSnapshot,
} from '../core/workspace';
import { confirmAction, promptForName } from './modals';
import {
  chatFacts,
  logSummary,
  type ProjectStatus,
} from '../core/projectBoard';
import { logNotePath } from '../core/memory';
import type { LoopResult, LoopSpec } from '../core/loops';
import {
  createScheduleNote,
  loadValidSchedules,
  setScheduleEnabled,
  updateScheduleNote,
  type Schedule,
  type ScheduleInput,
} from '../core/schedules';
import { togglePin } from '../core/quickChat';
import { applyObiAction, ensureObi, OBI_ID, type ObiOps } from '../core/obi';
import { appendActivityLine } from '../core/activity';
import {
  archiveProject,
  createProjectNote,
  loadValidProjects,
  type ProjectInput,
  updateProjectNote,
  type ProjectFields,
} from '../core/projects';
import { affectedAgentId } from '../core/tabs';
import type { NoteType } from '../core/noteTypes';
import type { ModelChoice } from '../core/models';
import { M365_WARNING, m365UnavailableReason } from '../core/m365/launch';

export class WorkspaceController implements WorkspaceActions {
  private state: WorkspaceSnapshot = {
    agents: [],
    invalidAgents: [],
    groups: [],
    skills: [],
    layout: {},
    selectedId: null,
    selectionRevision: 0,
    agentTab: 'chat',
    loading: true,
    error: null,
    // Hidden until the saved settings say otherwise, so nothing shows before the plugin has loaded.
    tourDone: true,
    disclaimerAccepted: true,
  };
  private readonly listeners = new Set<() => void>();
  private store: Store | null = null;
  private generation = 0;
  private disposed = false;
  private operations: Promise<unknown> = Promise.resolve();
  private chat?: Pick<
    ChatService,
    | 'send'
    | 'refreshAgents'
    | 'broadcast'
    | 'stop'
    | 'stopAll'
    | 'resolveInbox'
    | 'newConversation'
    | 'chatNotes'
    | 'deleteChats'
    | 'projectBusy'
    | 'projectMemoryInfo'
    | 'startLoop'
    | 'tickSchedules'
    | 'runScheduleNow'
    | 'resumeSchedule'
    | 'forkChat'
    | 'askOnce'
    | 'sideChat'
    | 'continueChat'
    | 'resolveProposal'
    | 'resolveCommand'
    | 'renameChat'
    | 'getSnapshot'
    | 'subscribe'
  >;
  private unsubscribeChat?: () => void;

  attachChat(
    chat: NonNullable<WorkspaceController['chat']>,
    developerMode = false,
  ): void {
    this.unsubscribeChat?.();
    this.chat = chat;
    this.publish({ ...this.state, chat: chat.getSnapshot(), developerMode });
    this.unsubscribeChat = chat.subscribe((snapshot) =>
      this.publish({ ...this.state, chat: snapshot }),
    );
  }
  async saveImage(file: File): Promise<ImageAttachment> {
    if (!this.store || this.disposed)
      throw new Error('Workspace is not ready.');
    return saveImageAttachment(this.app, this.store.root, file);
  }
  private withImages(text: string, images: ImageAttachment[]): string {
    if (!images.length) return text;
    if (!this.store || !(this.app.vault.adapter instanceof FileSystemAdapter))
      throw new Error('A local vault is required for images.');
    return imageMessage(text, images, this.store.root);
  }
  sendMessage(
    id: string,
    text: string,
    images: ImageAttachment[] = [],
    projectId?: string,
  ): Promise<void> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.send(id, this.withImages(text, images), projectId);
  }
  startLoop(
    agentId: string,
    spec: LoopSpec,
    message: string,
    projectId?: string,
  ): Promise<LoopResult> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.startLoop(agentId, spec, message, projectId);
  }
  createSchedule(input: ScheduleInput): Promise<string> {
    return this.mutate(async () => {
      const path = await createScheduleNote(
        this.requireStore(),
        this.requireStore().root,
        input,
        new Date(),
      );
      await this.refresh();
      return path;
    });
  }
  setScheduleEnabled(path: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      await setScheduleEnabled(this.requireStore(), path, enabled, new Date());
      await this.refresh();
    });
  }
  updateSchedule(
    path: string,
    input: Omit<ScheduleInput, 'name'>,
  ): Promise<void> {
    return this.mutate(async () => {
      await updateScheduleNote(this.requireStore(), path, input, new Date());
      await this.refresh();
    });
  }
  deleteSchedule(path: string): Promise<void> {
    return this.mutate(async () => {
      await this.requireStore().trashNote(path);
      await this.refresh();
    });
  }
  runScheduleNow(path: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.chat) throw new Error('Chat is not ready.');
      await this.chat.runScheduleNow(path);
      await this.refresh();
    });
  }
  resumeSchedule(path: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.chat) throw new Error('Chat is not ready.');
      await this.chat.resumeSchedule(path);
      await this.refresh();
    });
  }
  async tickSchedules(): Promise<void> {
    if (!this.store || !this.chat || this.disposed) return;
    await this.chat.tickSchedules(new Date());
    await this.refresh();
  }
  askOnce(
    agentId: string,
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ text: string; costUsd: number; isError: boolean }> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.askOnce(agentId, prompt, signal);
  }
  askSide(
    agentId: string,
    question: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ text: string; costUsd: number; isError: boolean }> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.sideChat(agentId, question, signal);
  }
  mentionCandidates(agentId: string, query: string): MentionCandidate[] {
    const candidates: MentionCandidate[] = [];
    for (const file of this.app.vault.getMarkdownFiles())
      candidates.push({
        kind: 'note',
        label: file.basename,
        path: file.path,
      });
    for (const folder of this.app.vault.getAllFolders())
      if (folder.path !== '/')
        candidates.push({
          kind: 'folder',
          label: folder.name,
          path: folder.path,
        });
    const chats = this.state.chat?.agents ?? {};
    for (const [id, entry] of Object.entries(chats)) {
      if (id === agentId) continue;
      for (const note of entry.history.slice(-5))
        candidates.push({
          kind: 'chat',
          label: `${entry.agent.name}: ${conversationTitle(note)}`,
          path: note.path,
        });
    }
    return rankMentions(query, candidates);
  }
  async resolveMention(
    candidate: MentionCandidate,
  ): Promise<AttachedNote | null> {
    if (candidate.kind === 'folder') {
      const prefix = `${candidate.path}/`;
      const paths = this.app.vault
        .getMarkdownFiles()
        .map((file) => file.path)
        .filter((path) => path.startsWith(prefix))
        .sort();
      return {
        path: candidate.path,
        kind: 'folder',
        ...folderListing(candidate.path, paths),
      };
    }
    const file = this.app.vault.getFileByPath(candidate.path);
    if (!file) return null;
    const text = await this.app.vault.cachedRead(file);
    if (candidate.kind === 'chat')
      return {
        path: candidate.label,
        kind: 'chat',
        ...chatMention({
          path: file.path,
          name: file.basename,
          frontmatter: {},
          body: text,
        }),
      };
    return {
      path: file.path,
      kind: 'note',
      content: text.slice(0, NOTE_ATTACH_LIMIT),
      truncated: text.length > NOTE_ATTACH_LIMIT,
    };
  }
  /** The note open in the editor, read-only, cut at NOTE_ATTACH_LIMIT characters. */
  async currentNote(): Promise<AttachedNote | null> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return null;
    const text = await this.app.vault.cachedRead(file);
    return {
      path: file.path,
      content: text.slice(0, NOTE_ATTACH_LIMIT),
      truncated: text.length > NOTE_ATTACH_LIMIT,
    };
  }
  /** Forks a conversation at one of its messages; the new chat becomes the agent's current one. */
  forkChat(agentId: string, index: number): Promise<string> {
    return this.mutate(async () => {
      if (!this.chat) throw new Error('Chat is not ready.');
      const path = await this.chat.forkChat(agentId, index);
      await this.refresh();
      return path;
    });
  }
  createSkill(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<string> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const path = await createSkillNote(store, store.root, input);
      await this.refresh();
      return path;
    });
  }
  updateSkill(
    path: string,
    patch: { description?: string; instructions?: string },
  ): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      await updateSkillNote(
        store,
        this.skillAt(await store.loadSkills(), path),
        patch,
      );
      await this.refresh();
    });
  }
  assignSkill(
    path: string,
    change: { agentIds: string[]; projectIds: string[]; add: boolean },
  ): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      await assignSkillTo(
        store,
        this.skillAt(await store.loadSkills(), path),
        change,
      );
      await this.refresh();
    });
  }
  deleteSkill(path: string): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      await deleteSkillNote(
        store,
        this.skillAt(await store.loadSkills(), path),
      );
      await this.refresh();
    });
  }
  private skillAt(skills: Skill[], path: string): Skill {
    const skill = skills.find((entry) => entry.path === path);
    if (!skill) throw new Error('That skill could not be read.');
    return skill;
  }
  stopAgent(id: string): Promise<void> {
    return this.chat?.stop(id) ?? Promise.resolve();
  }
  broadcast(
    target: BroadcastTarget,
    text: string,
    images: ImageAttachment[] = [],
    projectId?: string,
  ): Promise<void> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.broadcast(
      target,
      this.withImages(text, images),
      projectId,
    );
  }
  /** Creates or edits a project note; the form's fields go to the note exactly as entered. */
  saveProject(input: ProjectInput): Promise<string> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const path =
        input.path ??
        (await createProjectNote(store, store.root, {
          name: input.name,
          goal: input.goal,
          instructions: input.instructions,
        }));
      const output = input.outputFolder?.trim() || undefined;
      if (output) {
        const problem = outputFolderProblem(
          output,
          store.root,
          this.app.vault.configDir,
        );
        if (problem) throw new Error(problem);
        await ensureFolder(store, output);
      }
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      await updateProjectNote(store, project, {
        status: input.status,
        goal: input.goal,
        deadline: input.deadline,
        costLimitUsd: input.costLimitUsd,
        teams: input.teams,
        agents: input.agents,
        skills: input.skills,
        outputFolder: output,
        memoryModel: input.memoryModel,
        contextLevels: input.contextLevels,
        instructions: input.instructions,
      });
      await this.refresh();
      return path;
    });
  }
  archiveProject(path: string): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      await archiveProject(store, project);
      await this.refresh();
    });
  }
  setProjectArchived(path: string, archived: boolean): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      await updateProjectNote(store, project, { archived });
      await this.refresh();
    });
  }
  setProjectStatus(path: string, status: ProjectStatus): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      await updateProjectNote(store, project, { status });
      await this.refresh();
    });
  }
  async projectMemoryInfo(path: string): Promise<ProjectMemoryInfo> {
    const store = this.requireStore();
    const project = loadValidProjects(await store.loadProjects()).find(
      (entry) => entry.path === path,
    );
    if (!project) throw new Error('That project could not be read.');
    if (!this.chat)
      return { model: 'Chat is not ready', notes: 0, lastContextWords: null };
    return this.chat.projectMemoryInfo(project);
  }
  deleteProject(path: string): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      if (this.chat?.projectBusy(project.id))
        throw new Error(
          'Stop or wait for a running reply in this project before deleting it.',
        );
      await store.trashNote(project.path);
      await this.refresh();
    });
  }
  async resolveInbox(
    id: string,
    action: 'accept' | 'retry' | 'cancel' | 'dismiss',
  ): Promise<void> {
    if (!this.chat) throw new Error('Chat is not ready.');
    await this.chat.resolveInbox(id, action);
    await this.refresh();
  }
  stopAll(): Promise<void> {
    return this.chat?.stopAll() ?? Promise.resolve();
  }
  deleteConversation(id: string): Promise<void> {
    const path = this.state.chat?.agents[id]?.session?.path;
    return this.removeChats(
      id,
      path ? [path] : [],
      'Delete this conversation?',
    );
  }
  deleteAgentHistory(id: string): Promise<void> {
    return this.removeChats(
      id,
      undefined,
      'Delete all chat history for this agent?',
    );
  }
  continueChat(id: string, path: string): Promise<void> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.continueChat(id, path);
  }
  deleteGroupHistory(groupId: string): Promise<void> {
    const members = this.state.agents
      .filter((agent) => agent.group === groupId)
      .map((agent) => agent.id);
    return this.removeChatsForAgents(
      members,
      'Delete all chat history for this group?',
    );
  }
  renameChat(id: string, path: string, current: string): Promise<void> {
    promptForName(
      this.app,
      'Rename conversation',
      async (title) => {
        if (!this.chat) throw new Error('Chat is not ready.');
        await this.chat.renameChat(id, path, title);
      },
      (error) => this.reportError(error),
      false,
      'Rename',
      current,
    );
    return Promise.resolve();
  }
  deleteChatNotes(id: string, paths: string[]): Promise<void> {
    return this.removeChats(
      id,
      paths,
      paths.length === 1
        ? 'Delete this conversation?'
        : 'Delete the selected conversations?',
    );
  }
  deleteAllHistory(): Promise<void> {
    return this.removeChats(null, undefined, 'Delete all chat history?');
  }
  private async removeChatsForAgents(
    agentIds: string[],
    title: string,
  ): Promise<void> {
    if (!this.chat) throw new Error('Chat is not ready.');
    const paths = (await this.chat.chatNotes(null))
      .filter((note) => {
        const agentId = (note.frontmatter as { agentId?: unknown } | null)
          ?.agentId;
        return typeof agentId === 'string' && agentIds.includes(agentId);
      })
      .map((note) => note.path);
    await this.removeChats(null, paths, title);
  }
  private async removeChats(
    agentId: string | null,
    paths: string[] | undefined,
    title: string,
  ): Promise<void> {
    if (!this.chat) throw new Error('Chat is not ready.');
    const count = (await this.chat.chatNotes(agentId)).filter(
      (note) => !paths || paths.includes(note.path),
    ).length;
    if (
      count &&
      !(await confirmAction(
        this.app,
        title,
        `Move ${count} chat note${count === 1 ? '' : 's'} to the trash? You can restore them from the trash. The next message starts a fresh conversation.`,
      ))
    )
      return;
    await this.chat.deleteChats(agentId, paths);
  }
  newConversation(id: string): Promise<void> {
    if (!this.chat) return Promise.reject(new Error('Chat is not ready.'));
    return this.chat.newConversation(id);
  }

  constructor(
    private readonly app: App,
    private readonly openAgent: (
      id: string,
      options: { tab: AgentTab; window?: boolean },
    ) => void = () => undefined,
    private readonly loadModels: (
      runtime: string,
    ) => Promise<ModelChoice[]> = async () => [],
    private readonly saveTour: (flags: {
      tourDone: boolean;
      disclaimerAccepted: boolean;
    }) => Promise<void> = async () => undefined,
    private readonly checkSetup: () => Promise<ToolCheck[]> = async () => [],
    private readonly rerunSafety: () => Promise<ToolCheck[]> = async () => [],
    private readonly agentFolderVisibility: {
      isHidden(): boolean;
      setHidden(hide: boolean): void;
    } = { isHidden: () => false, setHidden: () => undefined },
  ) {}

  readonly getSnapshot = (): WorkspaceSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async initialize(store: Store): Promise<void> {
    this.store = store;
    const layout = await store.loadLayout();
    const pins = await store.loadPins();
    if (this.disposed) return;
    this.publish({ ...this.state, layout, pins });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.store || this.disposed) return;
    const generation = ++this.generation;
    try {
      const [
        collection,
        groups,
        skills,
        tasks,
        projectNotes,
        chatNotes,
        scheduleNotes,
      ] = await Promise.all([
        this.store.loadAgents(),
        this.store.loadGroups(),
        this.store.loadSkills(),
        this.store.loadTasks(),
        this.store.loadProjects(),
        this.store.loadChats(),
        this.store.loadNotesUnder(`${this.store.root}/Schedules`),
      ]);
      if (this.disposed || generation !== this.generation) return;
      const projects = loadValidProjects(projectNotes);
      const store = this.store;
      const projectLogs = Object.fromEntries(
        await Promise.all(
          projects.map(
            async (project) =>
              [
                project.id,
                logSummary(
                  await store.loadNote(logNotePath(store.root, project)),
                ),
              ] as const,
          ),
        ),
      );
      if (this.disposed || generation !== this.generation) return;
      this.publish({
        ...this.state,
        ...collection,
        groups,
        skills,
        tasks,
        projects,
        projectLogs,
        projectChats: chatNotes.map(chatFacts),
        schedules: loadValidSchedules(scheduleNotes),
        loading: false,
        error: null,
      });
    } catch (error) {
      if (!this.disposed && generation === this.generation)
        this.setError(error);
    }
  }

  /** Opens the agent in its own tab, or focuses its existing tab. Never replaces another agent's tab. */
  selectAgent(id: string, tab: AgentTab = 'chat'): void {
    if (!this.state.agents.some((agent) => agent.id === id)) return;
    this.publish({
      ...this.state,
      selectedId: id,
      agentTab: tab,
      selectionRevision: this.state.selectionRevision + 1,
    });
    this.openAgent(id, { tab });
  }

  /** The focused tab's agent changed (the user clicked into it); only the shared selection follows. */
  focusAgent(id: string): void {
    if (this.state.selectedId === id) return;
    this.publish({ ...this.state, selectedId: id });
  }

  /** Opens the current agent in a tab split beside the focused one. */
  openBeside(id: string): void {
    this.openAgent(id, {
      tab: 'chat',
      window: true,
    });
  }

  setAgentTab(agentTab: AgentTab): void {
    this.publish({ ...this.state, agentTab });
  }

  setPinned(id: string, pinned: boolean): Promise<void> {
    return this.mutate(async () => {
      const pins = togglePin(this.state.pins ?? [], id, pinned);
      await this.requireStore().savePins(pins);
      this.publish({ ...this.state, pins });
    });
  }
  setAgentPlacement(agentPlacement: AgentPlacement): void {
    this.publish({ ...this.state, agentPlacement });
  }
  async approveProposal(agentId: string, proposalId: string): Promise<void> {
    const proposal = this.state.chat?.agents[agentId]?.proposals?.find(
      (entry) => entry.id === proposalId,
    );
    if (!proposal || !this.chat)
      throw new Error('That proposal is no longer pending.');
    await applyObiAction(proposal.action, this.obiOps());
    // The changed agent opens beside Obi; Obi's own tab keeps its chat.
    const changed = affectedAgentId(proposal.action, this.state.agents);
    if (changed) this.openAgent(changed, { tab: 'setup' });
    const store = this.requireStore();
    await appendActivityLine(
      store,
      store.root,
      `Obi applied: ${proposal.title}`,
    );
    this.chat.resolveProposal(agentId, proposalId);
  }
  rejectProposal(agentId: string, proposalId: string): void {
    this.chat?.resolveProposal(agentId, proposalId);
  }
  resolveCommand(agentId: string, cardId: string, approved: boolean): void {
    this.chat?.resolveCommand(agentId, cardId, approved);
  }
  restoreObi(): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      await ensureObi(store, store.root);
    }).then(async () => {
      await this.refresh();
      await this.setPinned(OBI_ID, true);
    });
  }
  async runSetupCheck(): Promise<void> {
    await this.runChecks(this.checkSetup);
  }
  /** Clears the stored safety results first, so a blocked or unsupported version is checked again. */
  async rerunSafetyCheck(): Promise<void> {
    await this.runChecks(this.rerunSafety);
  }
  private async runChecks(check: () => Promise<ToolCheck[]>): Promise<void> {
    this.publish({ ...this.state, setupChecking: true });
    try {
      const setup = await check();
      this.publish({ ...this.state, setup, setupChecking: false });
    } catch (error) {
      this.publish({ ...this.state, setupChecking: false });
      this.reportError(error);
    }
  }
  setAllowedFolders(folders: string[]): void {
    this.publish({ ...this.state, allowedFolders: [...folders] });
  }
  setTourState(tourDone: boolean, disclaimerAccepted: boolean): void {
    this.publish({ ...this.state, tourDone, disclaimerAccepted });
  }
  dismissTour(): void {
    this.publish({ ...this.state, tourDismissed: true });
  }
  async finishTour(): Promise<void> {
    this.publish({
      ...this.state,
      tourDone: true,
      disclaimerAccepted: true,
      tourDismissed: false,
    });
    await this.saveTour({ tourDone: true, disclaimerAccepted: true });
  }
  agentFolderHidden(): boolean {
    return this.agentFolderVisibility.isHidden();
  }
  setAgentFolderHidden(hide: boolean): void {
    this.agentFolderVisibility.setHidden(hide);
  }
  restartTour(): void {
    this.publish({ ...this.state, tourDone: false, tourDismissed: false });
  }
  private obiOps(): ObiOps {
    return {
      snapshot: () => ({
        agents: this.state.agents,
        groups: this.state.groups,
        projects: this.state.projects ?? [],
        schedules: this.state.schedules ?? [],
        skills: this.state.skills,
      }),
      createAgent: (name) => this.createAgent(name, false),
      updateAgent: (id, patch) => this.updateAgent(id, patch),
      createGroup: (name, color) => this.createGroup(name, color),
      renameGroup: (id, name) => this.renameGroupTo(id, name),
      setManager: (id, managerId) => this.setManager(id, managerId),
      projects: {
        createProject: async (input) => {
          await this.saveProject({
            name: input.name,
            goal: input.goal,
            instructions: input.instructions,
            status: input.status,
            teams: input.teams,
            agents: input.agents,
            skills: input.skills,
            archived: false,
            costLimitUsd: input.costLimitUsd,
            contextLevels: {},
          });
        },
        updateProject: (path, patch) => this.updateProjectFields(path, patch),
        createSchedule: (input) => this.createSchedule(input),
        patchSchedule: (path, patch) => this.patchScheduleFields(path, patch),
      },
      skills: {
        createSkill: (input) => this.createSkill(input),
        updateSkill: (path, patch) => this.updateSkill(path, patch),
        assignSkill: (path, change) => this.assignSkill(path, change),
      },
    };
  }
  /** Changes some fields of a project note; the rest of the note is kept. Used by Obi's approved updates. */
  private updateProjectFields(
    path: string,
    patch: Partial<ProjectFields> & { instructions?: string },
  ): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const project = loadValidProjects(await store.loadProjects()).find(
        (entry) => entry.path === path,
      );
      if (!project) throw new Error('That project could not be read.');
      await updateProjectNote(store, project, patch);
      await this.refresh();
    });
  }
  /** Changes some fields of a schedule; a project id of empty text removes the project link. */
  private patchScheduleFields(
    path: string,
    patch: {
      enabled?: boolean;
      rule?: Schedule['rule'];
      message?: string;
      projectId?: string;
      costCapUsd?: number;
      missedRun?: 'skip' | 'run-once';
    },
  ): Promise<void> {
    return this.mutate(async () => {
      const store = this.requireStore();
      const note = await store.loadNote(path);
      const current = note ? loadValidSchedules([note])[0] : undefined;
      if (!current) throw new Error('That schedule could not be read.');
      await updateScheduleNote(
        store,
        path,
        {
          agentId: current.agentId,
          projectId:
            patch.projectId === undefined
              ? current.projectId
              : patch.projectId === ''
                ? undefined
                : patch.projectId,
          rule: patch.rule ?? current.rule,
          message: patch.message ?? current.message,
          costCapUsd: patch.costCapUsd ?? current.costCapUsd,
          missedRun: patch.missedRun ?? current.missedRun,
          enabled: patch.enabled ?? current.enabled,
        },
        new Date(),
      );
      await this.refresh();
    });
  }
  private renameGroupTo(id: string, name: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.state.groups.some((group) => group.id === id))
        throw new Error('That group no longer exists.');
      await this.requireStore().saveGroups(
        this.state.groups.map((group) =>
          group.id === id ? { ...group, name: name.trim() } : group,
        ),
      );
      await this.refresh();
    });
  }
  /** Reads a runtime's model list once per session. A failed read is reported and retried later. */
  async loadRuntimeModels(runtime: string): Promise<void> {
    if (this.state.runtimeModels?.[runtime]) return;
    try {
      const list = await this.loadModels(runtime);
      this.publish({
        ...this.state,
        runtimeModels: { ...this.state.runtimeModels, [runtime]: list },
      });
    } catch (error) {
      this.reportError(error);
    }
  }
  setEnterToSend(enterToSend: boolean): void {
    this.publish({ ...this.state, enterToSend });
  }

  requestCreateAgent(): void {
    promptForName(
      this.app,
      'New agent',
      async (name) => {
        await this.createAgent(name);
      },
      (error) => this.reportError(error),
    );
  }

  requestCreateGroup(): void {
    promptForName(
      this.app,
      'New group',
      async (name, color) => {
        await this.createGroup(name, color);
      },
      (error) => this.reportError(error),
      true,
    );
  }

  createAgent(name: string, select = true): Promise<string> {
    return this.mutate(async () => {
      const id = await this.requireStore().createAgent(name);
      await this.refresh();
      await this.persistLayout(
        graphLayoutPositions(
          this.state.agents,
          this.state.groups,
          this.state.layout,
        ),
      );
      if (select) this.selectAgent(id, 'setup');
      return id;
    });
  }

  createGroup(name: string, color: string): Promise<string> {
    return this.mutate(async () => {
      if (!name.trim()) throw new Error('Enter a group name.');
      if (!/^#[0-9a-f]{6}$/i.test(color))
        throw new Error('Choose a valid group color.');
      const id = `group-${crypto.randomUUID()}`;
      await this.requireStore().saveGroups([
        ...this.state.groups,
        { id, name: name.trim(), color },
      ]);
      await this.refresh();
      await this.persistLayout(
        graphLayoutPositions(
          this.state.agents,
          this.state.groups,
          this.state.layout,
        ),
      );
      return id;
    });
  }

  setBrowserStatus(browser: BrowserStatus): void {
    this.publish({ ...this.state, browser });
  }
  setNoteTypes(noteTypes: NoteType[]): void {
    this.publish({ ...this.state, noteTypes });
  }
  setM365Status(m365: NonNullable<WorkspaceSnapshot['m365']>): void {
    this.publish({ ...this.state, m365 });
  }
  updateAgent(id: string, patch: AgentSetupPatch): Promise<void> {
    return this.mutate(async () => {
      const agent = this.state.agents.find((entry) => entry.id === id);
      if (!agent) throw new Error('The selected agent is no longer available.');
      const newTypes = (patch.noteTypes ?? []).filter(
        (id) => !(agent.noteTypes ?? []).includes(id),
      );
      if (newTypes.length) {
        const folders = (this.state.noteTypes ?? [])
          .filter((type) => newTypes.includes(type.id))
          .map((type) => `${type.label}: ${type.folder}/`);
        if (
          !(await confirmAction(
            this.app,
            'Allow this agent to write notes in your vault?',
            `It will be able to create and edit notes in: ${folders.join('; ')}. It still cannot write anywhere else in your vault.`,
          ))
        )
          throw Error(
            'Note destinations were not confirmed; no fields were saved.',
          );
      }
      if (patch.canUseM365 ?? agent.canUseM365) {
        const reason = m365UnavailableReason(
          patch.runtime ?? agent.runtime,
          this.state.m365?.connected ?? false,
        );
        if (reason) throw Error(reason);
        if (
          !agent.canUseM365 &&
          !(await confirmAction(this.app, 'Allow Microsoft 365?', M365_WARNING))
        )
          throw Error('Microsoft 365 was not confirmed; no fields were saved.');
      }
      if (patch.canUseBrowser ?? agent.canUseBrowser) {
        const reason = browserUnavailableReason(
          patch.runtime ?? agent.runtime,
          patch.wholeComputerReadConfirmed ??
            agent.wholeComputerReadConfirmed ??
            false,
          this.state.browser?.engine ?? 'playwright',
          patch.browserReadsConfirmed ?? agent.browserReadsConfirmed ?? false,
        );
        if (reason) throw Error(reason);
        if (!this.state.browser?.available)
          throw Error(
            this.state.browser?.hint ??
              'Set up browser tools in Settings first.',
          );
        if (
          !agent.canUseBrowser &&
          !(await confirmAction(
            this.app,
            'Allow browser control?',
            (patch.runtime ?? agent.runtime) === 'codex'
              ? `${BROWSER_WARNING} ${BROWSER_CODEX_WARNING}`
              : BROWSER_WARNING,
          ))
        )
          throw Error(
            'Browser control was not confirmed; no fields were saved.',
          );
      }
      if (
        patch.wholeComputerReadConfirmed === true &&
        !agent.wholeComputerReadConfirmed &&
        patch.webAccess === undefined
      )
        patch = { ...patch, webAccess: false };
      const readWarning = runtimeReadWarning(patch.runtime ?? agent.runtime);
      if (
        readWarning &&
        (patch.wholeComputerReadConfirmed ??
          agent.wholeComputerReadConfirmed) === true &&
        (!agent.wholeComputerReadConfirmed ||
          (patch.runtime !== undefined && patch.runtime !== agent.runtime))
      ) {
        if (
          !(await confirmAction(
            this.app,
            'Allow whole-computer reads?',
            readWarning,
          ))
        )
          throw Error('Whole-computer read access was not confirmed.');
      }
      if (patch.vaultAccess === 'write' && agent.vaultAccess !== 'write') {
        const approved = await confirmAction(
          this.app,
          'Allow vault write access?',
          'Vault write access lets this agent modify notes across your vault. Protected configuration, Agents, Tasks, Activity and Attachments stay denied. Only confirm if you trust this agent.',
        );
        if (!approved)
          throw new Error(
            'Vault write access was not confirmed; no fields were saved.',
          );
      }
      if (patch.permission === 'full' && agent.permission !== 'full') {
        const approved = await confirmAction(
          this.app,
          'Allow full permission?',
          'Full permission requests unrestricted actions. Only confirm if you trust this agent. Runtimes must still enforce protected folders and may refuse this mode.',
        );
        if (!approved)
          throw new Error(
            'Full permission was not confirmed; no fields were saved.',
          );
      }
      if (
        patch.group &&
        !this.state.groups.some((group) => group.id === patch.group)
      )
        throw new Error('The selected group no longer exists.');
      await this.requireStore().patchAgent(id, patch);
      // Do not leave a stale (possibly broader) policy until the vault event debounce.
      await this.chat?.refreshAgents();
      await this.refresh();
    });
  }

  setManager(id: string, managerId: string | null): Promise<void> {
    return this.mutate(async () => {
      await this.requireStore().setManager(id, managerId);
      await this.refresh();
    });
  }

  moveAgent(id: string, position: Point): Promise<void> {
    return this.mutate(async () => {
      if (!this.state.agents.some((agent) => agent.id === id)) return;
      await this.persistLayout({ ...this.state.layout, [id]: position });
    });
  }

  moveGroup(id: string, position: Point): Promise<void> {
    return this.mutate(async () => {
      if (!this.state.groups.some((group) => group.id === id)) return;
      const positions = graphLayoutPositions(
        this.state.agents,
        this.state.groups,
        this.state.layout,
      );
      const key = `group:${id}`;
      const previous = positions[key];
      if (!previous) return;
      const layout: Layout = { ...this.state.layout, [key]: position };
      for (const agent of this.state.agents.filter(
        (entry) => entry.group === id,
      )) {
        const point = positions[agent.id];
        if (point)
          layout[agent.id] = {
            x: point.x + position.x - previous.x,
            y: point.y + position.y - previous.y,
          };
      }
      await this.persistLayout(layout);
    });
  }

  deleteAgent(id: string): Promise<void> {
    return this.mutate(async () => {
      const agent = this.state.agents.find((entry) => entry.id === id);
      if (!agent) return;
      if (
        !(await confirmAction(
          this.app,
          'Delete agent?',
          `Move ${agent.name}'s note to trash? Direct reports will move to this agent's manager.`,
        ))
      )
        return;
      await this.requireStore().deleteAgent(id);
      const layout = { ...this.state.layout };
      delete layout[id];
      await this.persistLayout(layout, id);
      if (this.state.selectedId === id)
        this.publish({ ...this.state, selectedId: null });
      await this.refresh();
    });
  }

  deleteGroup(id: string): Promise<void> {
    return this.mutate(async () => {
      const group = this.state.groups.find((entry) => entry.id === id);
      if (!group) return;
      if (
        !(await confirmAction(
          this.app,
          'Delete group?',
          `Delete ${group.name}'s frame? Agent notes will be kept and ungrouped.`,
        ))
      )
        return;
      const layout = graphLayoutPositions(
        this.state.agents,
        this.state.groups,
        this.state.layout,
      );
      delete layout[`group:${id}`];
      for (const agent of this.state.agents.filter(
        (entry) => entry.group === id,
      ))
        await this.requireStore().patchAgent(agent.id, { group: null });
      await this.requireStore().saveGroups(
        this.state.groups.filter((entry) => entry.id !== id),
      );
      await this.persistLayout(layout, `group:${id}`);
      await this.refresh();
    });
  }

  async openNote(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (file) await this.app.workspace.getLeaf('tab').openFile(file);
  }

  reportError(error: unknown): void {
    new Notice(
      error instanceof Error ? error.message : 'The operation failed.',
    );
  }

  setError(error: unknown): void {
    this.publish({
      ...this.state,
      loading: false,
      error:
        error instanceof Error ? error.message : 'Could not load the team.',
    });
    this.reportError(error);
  }

  dispose(): void {
    this.unsubscribeChat?.();
    this.disposed = true;
    this.generation++;
    this.listeners.clear();
  }

  private publish(state: WorkspaceSnapshot): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private requireStore(): Store {
    if (!this.store || this.disposed)
      throw new Error('The team workspace is not ready.');
    return this.store;
  }

  private async persistLayout(
    layout: Layout,
    removedKey?: string,
  ): Promise<void> {
    const store = this.requireStore();
    const merged = { ...(await store.loadLayout()), ...layout };
    // Only an explicit delete operation may remove its own persisted key.
    if (removedKey !== undefined) delete merged[removedKey];
    await store.saveLayout(merged);
    this.publish({ ...this.state, layout: merged });
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const task = this.operations.then(() => {
      this.requireStore();
      return action();
    });
    this.operations = task.catch(() => undefined);
    return task;
  }
}
