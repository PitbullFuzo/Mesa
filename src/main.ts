import {
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  requestUrl,
  TFile,
  type WorkspaceLeaf,
  type WorkspaceSplit,
} from 'obsidian';
import { askAboutNote, importSkills } from './core/vaultPowers';
import { readInstalledSkills } from './core/runtimes/skills';
import { pickAgent, confirmAction } from './obsidian/modals';
import { pinnedAgents, statusGlyph } from './core/quickChat';
import { agentDisplayName, ensureObi, OBI_ID } from './core/obi';
import { syncGuideNote } from './core/guide';
import { ensureNoteSkills } from './core/noteTypes';
import { checkSetup, setupLine, type ToolCheck } from './core/setupCheck';
import { clearSafetyChecks } from './core/runtimes/selfTest';
import {
  GRAPH_MAP_NAME,
  isVaultSearchable,
  syncVaultMap,
  type VaultFile,
  VAULT_MAP_NAME,
} from './core/vaultMap';
import {
  analyseLinkGraph,
  buildLinkGraph,
  renderGraphMap,
  syncGraphMap,
  type GraphAnalysis,
} from './core/graphMap';
import {
  graphAiCandidates,
  graphActivityLine,
  graphAiSection,
  loadGraphConcepts,
  runGraphAiPass,
  saveGraphConcepts,
  stripFrontmatter,
  type GraphAiResult,
} from './core/graphAi';
import { appendActivityLine } from './core/activity';
import { VaultIndex } from './obsidian/vaultIndex';
import {
  openReorganiseModal,
  undoLastReorganisation,
  type ReorganiseDeps,
} from './obsidian/reorganise';

/** A few minutes: the map is rebuilt once per window at most, not on every keystroke. */
const VAULT_MAP_DELAY_MS = 3 * 60_000;
import { openProjectForm, pickProject } from './obsidian/projectModal';
import { runtimeModelList } from './core/runtimes/modelLists';
import type { AgentPlacement, AgentTab } from './core/workspace';
import { openPlan, tabState } from './core/tabs';
import {
  browserToolsStatus,
  installBrowserTools,
} from './core/runtimes/browserTools';
import { browserUnavailableReason } from './core/browser';
import { LEGACY_PLUGIN_IDS, migrateAppData, PLUGIN_ID } from './core/appData';
import { DEFAULT_M365_CLIENT_ID } from './core/m365/auth';
import {
  decideTeamFolder,
  LEGACY_TEAM_FOLDERS,
  rebuildMapAfterRemoval,
  TeamFolderGuard,
} from './core/teamFolder';
import { M365SignInModal } from './obsidian/m365SignIn';
import { embeddedHelpers, installHelpers } from './core/helpers';
import {
  accountLabel as m365AccountLabel,
  disconnect as m365Disconnect,
  finishDeviceCode,
  isConnected as m365IsConnected,
  needsNewPermission,
  startDeviceCode,
} from './core/m365/auth';
import { registerNoteMenus } from './obsidian/menus';
import { realpath } from 'node:fs/promises';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';
import { ChatService } from './core/chat';
import { createRuntimeAdapters } from './core/runtimes/registry';
import '../styles.css';
import { isFolderHidden, setFolderHidden } from './core/folders';
import { loadSettings, type AgentHQSettings } from './core/settings';
import { ensureAgentHqFolders, initializeStarterTeam } from './core/starter';
import { ObsidianStore } from './obsidian/obsidianStore';
import { AgentHQSettingTab } from './obsidian/settings';
import { WorkspaceController } from './obsidian/workspaceController';
import { GraphView, GRAPH_VIEW } from './obsidian/views/graphView';
import {
  VAULT_OVERVIEW_VIEW,
  VaultOverviewView,
} from './obsidian/views/overview';
import {
  AgentPanel,
  ProjectsPanel,
  TeamPanel,
  AGENT_VIEW,
  PROJECTS_VIEW,
  SCHEDULES_VIEW,
  SKILLS_VIEW,
  SchedulesPanel,
  SkillsPanel,
  TEAM_VIEW,
} from './obsidian/views/panels';

/** Microsoft calls go through Obsidian's own HTTP, as the plugin guidelines ask. */
const obsidianFetch = (async (url: string, init?: RequestInit) => {
  const response = await requestUrl({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: init?.headers as Record<string, string> | undefined,
    body: typeof init?.body === 'string' ? init.body : undefined,
    throw: false,
  });
  return new Response(response.status === 204 ? null : response.text, {
    status: response.status,
  });
}) as typeof fetch;

export default class AgentHQPlugin extends Plugin {
  settings: AgentHQSettings = loadSettings(null);
  private store: ObsidianStore | null = null;
  workspace!: WorkspaceController;
  private dataQueue: Promise<void> = Promise.resolve();
  private refreshTimer: number | null = null;

  private active = false;
  chat?: ChatService;
  private chatRefresh: Promise<void> = Promise.resolve();
  private runtimePathOverride = '';
  private runtimeRefreshTimer: number | null = null;
  private vaultIndex: VaultIndex | null = null;
  private mapTimer: number | null = null;
  /** Set while the team folder is being renamed: vault events for it are ignored until the plugin reloads. */
  readonly teamFolderGuard = new TeamFolderGuard();
  /** AI concepts results for this session, by note path. Lost on restart; a note is then read once more. */
  private graphAi = new Map<string, GraphAiResult>();
  private graphAiSession = { checked: 0, dropped: 0 };
  /** Everything the pass has spent (kept across restarts) and the status line Settings shows. */
  graphAiTotal = 0;
  graphAiStatus = '';
  private graphAiLoaded = false;
  private graphAiAbort: AbortController | null = null;
  private setupCache: { at: number; checks: ToolCheck[] } | null = null;

  async onload(): Promise<void> {
    this.active = true;
    await this.installHelperFiles();
    this.settings = await this.startingSettings();
    void migrateAppData().catch(() => {
      // Nothing to carry over, or it cannot be read: the owner just signs in again.
    });
    this.runtimePathOverride = this.settings.runtimePathOverride;
    this.workspace = new WorkspaceController(
      this.app,
      (id, options) => this.openAgentTab(id, options),
      (runtime) => runtimeModelList(runtime),
      async (flags) => {
        this.settings.tourDone = flags.tourDone;
        this.settings.disclaimerAccepted = flags.disclaimerAccepted;
        await this.saveSettings();
      },
      () => {
        this.setupCache = null;
        return this.checkSetupCached();
      },
      () => this.rerunSafetyChecks(),
      {
        isHidden: () =>
          isFolderHidden(this.vaultConfig(), `${this.settings.agenthqFolder}/`),
        setHidden: (hide) =>
          setFolderHidden(
            this.vaultConfig(),
            `${this.settings.agenthqFolder}/`,
            hide,
          ),
      },
    );
    this.workspace.setAgentPlacement(this.settings.agentPanelPlacement);
    this.workspace.setEnterToSend(this.settings.enterToSend);
    this.workspace.setTourState(
      this.settings.tourDone,
      this.settings.disclaimerAccepted,
    );
    this.workspace.setAllowedFolders(this.settings.allowedFolders);
    this.registerView(
      GRAPH_VIEW,
      (leaf) => new GraphView(leaf, this.workspace),
    );
    this.registerView(
      VAULT_OVERVIEW_VIEW,
      (leaf) =>
        new VaultOverviewView(
          leaf,
          () => this.overviewAnalysis(),
          (path) => this.openNote(path),
          {
            get: () => this.settings.overview,
            save: (overview) => {
              this.settings.overview = overview;
              void this.saveSettings();
            },
          },
        ),
    );
    this.registerView(
      AGENT_VIEW,
      (leaf) =>
        new AgentPanel(leaf, this.workspace, (current, target) =>
          this.moveAgentLeaf(current, target),
        ),
    );
    this.registerView(TEAM_VIEW, (leaf) => new TeamPanel(leaf, this.workspace));
    this.registerView(
      PROJECTS_VIEW,
      (leaf) =>
        new ProjectsPanel(leaf, this.workspace, (existing) =>
          openProjectForm(this.app, this.workspace, existing),
        ),
    );
    this.registerView(
      SCHEDULES_VIEW,
      (leaf) => new SchedulesPanel(leaf, this.workspace),
    );
    this.registerView(
      SKILLS_VIEW,
      (leaf) =>
        new SkillsPanel(leaf, this.workspace, () =>
          this.importInstalledSkills(),
        ),
    );
    this.addRibbonIcon('book-open', 'Skills', () => {
      void this.openView(SKILLS_VIEW);
    });
    this.addRibbonIcon('calendar-clock', 'Schedules', () => {
      void this.openView(SCHEDULES_VIEW);
    });
    this.addRibbonIcon('sparkles', 'Obi', () => {
      this.openObi();
    });
    this.addCommand({
      id: 'open-obi',
      name: 'Open Obi',
      callback: () => this.openObi(),
    });
    this.addCommand({
      id: 'take-tour',
      name: 'Take the tour again',
      callback: () => {
        this.workspace.restartTour();
        this.workspace.selectAgent(OBI_ID, 'chat');
      },
    });
    this.addCommand({
      id: 'rerun-safety-check',
      name: 'Re-run safety check',
      callback: () => {
        this.rerunSafetyChecks()
          .then((checks) => {
            new Notice(checks.map(setupLine).join('\n'), 30000);
          })
          .catch((error: unknown) => this.workspace.reportError(error));
      },
    });
    this.addCommand({
      id: 'reorganise-vault',
      name: 'Reorganise vault…',
      callback: () => {
        const deps = this.reorganiseDeps();
        if (deps) openReorganiseModal(deps);
      },
    });
    this.addCommand({
      id: 'undo-reorganise',
      name: 'Undo last reorganisation',
      callback: () => {
        const deps = this.reorganiseDeps();
        if (deps)
          void undoLastReorganisation(deps).catch((error: unknown) =>
            this.workspace.reportError(error),
          );
      },
    });
    this.addCommand({
      id: 'check-setup',
      name: 'Check my setup',
      callback: () => {
        this.setupCache = null;
        this.checkSetupCached()
          .then((checks) => {
            new Notice(checks.map(setupLine).join('\n'), 30000);
          })
          .catch((error: unknown) => this.workspace.reportError(error));
      },
    });
    this.addRibbonIcon('network', 'Open AI Graph', () => {
      void this.openView(GRAPH_VIEW);
    });
    this.addCommand({
      id: 'open-ai-graph',
      name: 'Open AI Graph',
      callback: () => this.openView(GRAPH_VIEW),
    });
    this.addRibbonIcon('circle-dot', 'Vault overview', () => {
      void this.openView(VAULT_OVERVIEW_VIEW);
    });
    this.addCommand({
      id: 'open-vault-overview',
      name: 'Open vault overview',
      callback: () => this.openView(VAULT_OVERVIEW_VIEW),
    });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view.getViewType() !== AGENT_VIEW) return;
        const agentId = tabState(leaf.getViewState().state)?.agentId;
        if (agentId) this.workspace.focusAgent(agentId);
      }),
    );
    // Schedules run only while Obsidian is open: a check every minute runs the ones that are due.
    this.registerInterval(
      window.setInterval(() => {
        this.workspace
          .tickSchedules()
          .catch((error: unknown) => this.workspace.reportError(error));
      }, 60_000),
    );
    this.addRibbonIcon('folder-kanban', 'Projects', () => {
      void this.openView(PROJECTS_VIEW);
    });
    this.addRibbonIcon('message-circle', 'Mesa chat', (event) => {
      this.openQuickChat(event);
    });
    this.addCommand({
      id: 'open-quick-chat',
      name: 'Open chat',
      callback: () => this.openQuickChat(),
    });
    this.addCommand({
      id: 'open-team-panel',
      name: 'Open Team panel',
      callback: () => this.openView(TEAM_VIEW),
    });
    this.addCommand({
      id: 'open-agent-panel',
      name: 'Open Agent panel',
      callback: () => this.openView(AGENT_VIEW),
    });
    this.addCommand({
      id: 'open-skills',
      name: 'Open skills',
      callback: () => this.openView(SKILLS_VIEW),
    });
    this.addCommand({
      id: 'open-schedules',
      name: 'Open schedules',
      callback: () => this.openView(SCHEDULES_VIEW),
    });
    this.addCommand({
      id: 'open-projects',
      name: 'Open projects',
      callback: () => this.openView(PROJECTS_VIEW),
    });
    this.addCommand({
      id: 'manage-projects',
      name: 'Manage projects',
      callback: () => pickProject(this.app, this.workspace),
    });
    this.addCommand({
      id: 'new-agent',
      name: 'New agent',
      callback: () => this.workspace.requestCreateAgent(),
    });
    this.addCommand({
      id: 'stop-all-agents',
      name: 'Stop all agents',
      callback: () => this.workspace.stopAll(),
    });
    this.addSettingTab(new AgentHQSettingTab(this.app, this));
    registerNoteMenus(
      this,
      (file) => this.requestAskAboutNote(file),
      (error) => this.workspace.reportError(error),
    );
    const refreshIfManaged = (path: string): void => {
      if (
        !this.teamFolderGuard.active &&
        this.isManaged(path) &&
        !path.startsWith(`${this.store!.root}/Chats/`)
      )
        this.requestTeamRefresh();
    };
    this.registerEvent(
      this.app.vault.on('create', (file) => refreshIfManaged(file.path)),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => refreshIfManaged(file.path)),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => refreshIfManaged(file.path)),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        refreshIfManaged(file.path);
        refreshIfManaged(oldPath);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) =>
        refreshIfManaged(file.path),
      ),
    );

    this.register(() => {
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      if (this.runtimeRefreshTimer !== null)
        window.clearTimeout(this.runtimeRefreshTimer);
      this.workspace.dispose();
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.active) void this.initializeNotes();
    });
  }

  private async requestAskAboutNote(file: TFile): Promise<void> {
    if (!this.chat || !this.store)
      throw new Error('Mesa is still loading. Try again in a moment.');
    const { agents } = await this.store.loadAgents();
    if (!agents.length)
      throw new Error(
        'No healthy agents found. Repair or create an agent first.',
      );
    pickAgent(
      this.app,
      agents,
      async (agent) => {
        if (!this.active || !this.chat) return;
        const content = await this.app.vault.read(file);
        this.workspace.selectAgent(agent.id);
        await askAboutNote(this.chat, agent.id, file.path, content);
      },
      (error) => this.workspace.reportError(error),
    );
  }

  /** What the reorganiser needs, or null (with a notice) while Mesa is still loading. */
  private reorganiseDeps(): ReorganiseDeps | null {
    if (!this.store || !this.chat) {
      new Notice('Mesa is still loading. Try again in a moment.');
      return null;
    }
    return {
      app: this.app,
      chat: this.chat,
      store: this.store,
      workspace: this.workspace,
      root: this.store.root,
    };
  }

  /** Opens Obi's Chat. If Obi was deleted, offers to restore it first. */
  openObi(): void {
    const open = () => this.workspace.selectAgent(OBI_ID, 'chat');
    if (
      this.workspace.getSnapshot().agents.some((agent) => agent.id === OBI_ID)
    )
      return open();
    void confirmAction(
      this.app,
      'Obi is missing',
      'Restore the built-in assistant? Existing notes are never overwritten.',
    )
      .then(async (restore) => {
        if (!restore) return;
        await this.workspace.restoreObi();
        open();
      })
      .catch((error: unknown) => this.workspace.reportError(error));
  }

  /** Pinned agents first, then every agent through the picker; picking one opens its Chat. */
  openQuickChat(event?: MouseEvent): void {
    const snapshot = this.workspace.getSnapshot();
    const menu = new Menu();
    for (const agent of pinnedAgents(snapshot.pins ?? [], snapshot.agents))
      menu.addItem((item) =>
        item
          .setTitle(
            `${statusGlyph(snapshot.chat?.agents[agent.id]?.status ?? 'offline')} ${agentDisplayName(agent)}`,
          )
          .onClick(() => this.workspace.selectAgent(agent.id, 'chat')),
      );
    if (snapshot.pins?.length) menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('All agents…')
        .setIcon('search')
        .onClick(() =>
          pickAgent(
            this.app,
            snapshot.agents,
            async (agent) => this.workspace.selectAgent(agent.id, 'chat'),
            (error) => this.workspace.reportError(error),
          ),
        ),
    );
    if (event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: window.innerWidth / 2, y: 80 });
  }

  async importInstalledSkills(): Promise<void> {
    if (!this.store || !this.active)
      throw new Error('Mesa is still loading. Try again in a moment.');
    const source = await readInstalledSkills();
    const result = await importSkills(
      this.store,
      this.store.root,
      source.skills,
    );
    await this.workspace.refresh();
    new Notice(
      `Imported ${result.imported.length} skills; skipped ${result.skipped.length + source.skipped.length} (existing, unsafe or unreadable). Existing notes were kept.`,
    );
  }

  /**
   * Moves one agent's panel or window to the side panel or a main-area tab, keeping its agent and tab.
   * Used by the buttons in that panel, so a pop-out window can move back into the layout (16f).
   */
  async moveAgentLeaf(
    leaf: WorkspaceLeaf,
    target: AgentPlacement,
  ): Promise<void> {
    const { workspace } = this.app;
    const state = leaf.getViewState().state;
    this.settings.agentPanelPlacement = target;
    await this.saveSettings();
    this.workspace.setAgentPlacement(target);
    leaf.detach();
    const next =
      target === 'main' ? workspace.getLeaf('tab') : this.newSideLeaf();
    if (!next) return;
    await next.setViewState({ type: AGENT_VIEW, active: true, state });
    await workspace.revealLeaf(next);
  }

  /** A new side-panel leaf: a tab at the end of the main right-sidebar tab group, not a split (16e). */
  private newSideLeaf(): WorkspaceLeaf | null {
    const { workspace } = this.app;
    const groups = (
      workspace.rightSplit as unknown as {
        children: (WorkspaceSplit & { children: unknown[] })[];
      }
    ).children;
    const main = groups[0];
    if (!main) return workspace.getRightLeaf(false);
    return workspace.createLeafInParent(main, main.children.length);
  }

  /** Repairs a side-panel agent left in its own split by 16b/16d: it moves into the main tab group, keeping its agent and tab. */
  private async revealSideAgent(leaf: WorkspaceLeaf): Promise<void> {
    const { workspace } = this.app;
    const groups = (
      workspace.rightSplit as unknown as {
        children: (WorkspaceSplit & { children: unknown[] })[];
      }
    ).children;
    const main = groups[0];
    const inMain = (leaf.parent as unknown) === main;
    if (
      this.settings.agentPanelPlacement === 'side' &&
      leaf.getRoot() === workspace.rightSplit &&
      !inMain
    ) {
      const state = leaf.getViewState().state;
      leaf.detach();
      const moved = this.newSideLeaf();
      if (moved) {
        await moved.setViewState({ type: AGENT_VIEW, active: true, state });
        await workspace.revealLeaf(moved);
      }
      return;
    }
    await workspace.revealLeaf(leaf);
  }

  /**
   * Focuses an agent's existing panel or window. The first agent uses the placement; see openPlan.
   */
  openAgentTab(id: string, options: { tab: AgentTab; window?: boolean }): void {
    const { workspace } = this.app;
    const agentOf = (leaf: WorkspaceLeaf) =>
      tabState(leaf.getViewState().state)?.agentId;
    const leaves = workspace.getLeavesOfType(AGENT_VIEW);
    const existing = leaves.find((leaf) => agentOf(leaf) === id);
    const plan = openPlan({
      existing: !!existing,
      placement: this.settings.agentPanelPlacement,
      sideOccupied: leaves.some(
        (leaf) => leaf.getRoot() === workspace.rightSplit,
      ),
      windowRequested: !!options.window,
      windowsAvailable: typeof workspace.openPopoutLeaf === 'function',
    });
    if (plan === 'reveal') {
      void this.revealSideAgent(existing!);
      return;
    }
    const leaf =
      plan === 'window'
        ? workspace.openPopoutLeaf()
        : plan === 'main'
          ? workspace.getLeaf('tab')
          : this.newSideLeaf();
    if (!leaf) return;
    void leaf
      .setViewState({
        type: AGENT_VIEW,
        active: true,
        state: { agentId: id, tab: options.tab },
      })
      .then(() => workspace.revealLeaf(leaf));
  }

  async openView(type: string): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(type)[0] ?? null;
    if (!leaf) {
      leaf =
        type === TEAM_VIEW
          ? this.app.workspace.getLeftLeaf(false)
          : type === AGENT_VIEW
            ? this.settings.agentPanelPlacement === 'main'
              ? this.app.workspace.getLeaf('tab')
              : this.app.workspace.getRightLeaf(false)
            : this.app.workspace.getLeaf('tab');
      if (!leaf) return;
      await leaf.setViewState({ type, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private m365Connected = false;
  private m365Signin: AbortController | null = null;

  /** Reads whether a Microsoft account is connected and tells the panels. */
  /** A release holds only main.js, manifest.json and styles.css: write the helper programs beside them. */
  /**
   * This plugin's saved settings. A test vault that used the plugin under its earlier id has them in the old plugin
   * folder: they are copied over once (the old folder is never touched). A vault that already has the earlier
   * Obi-I or AgentHQ folder and no choice saved keeps using it; the folder is never moved by itself.
   */
  private async startingSettings(): Promise<AgentHQSettings> {
    let data: unknown = await this.loadData();
    const adapter = this.app.vault.adapter;
    let copied = false;
    if (data === null || data === undefined) {
      for (const id of LEGACY_PLUGIN_IDS) {
        try {
          data = JSON.parse(
            await adapter.read(
              `${this.app.vault.configDir}/plugins/${id}/data.json`,
            ),
          ) as unknown;
          copied = true;
          break;
        } catch {
          data = null;
        }
      }
    }
    const settings = loadSettings(data);
    const chosen =
      data !== null && typeof data === 'object' && 'agenthqFolder' in data;
    try {
      if (!chosen && !(await adapter.exists(settings.agenthqFolder)))
        for (const folder of LEGACY_TEAM_FOLDERS)
          if (await adapter.exists(folder)) {
            settings.agenthqFolder = folder;
            break;
          }
    } catch {
      // Cannot look: use the default.
    }
    if (copied) await this.saveData(settings);
    return settings;
  }

  private async installHelperFiles(): Promise<void> {
    // The plugin's own folder, vault-relative; tests construct the plugin without a manifest.
    const dir = (this.manifest as { dir?: string } | undefined)?.dir;
    if (!dir) return;
    const adapter = this.app.vault.adapter;
    try {
      await installHelpers(embeddedHelpers(), dir, {
        exists: (path) => adapter.exists(path),
        read: (path) => adapter.read(path),
        write: (path, text) => adapter.write(path, text),
      });
    } catch (error) {
      new Notice(
        `Mesa could not write its helper files: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** Settings → Note destinations changed: tell the Setup panels. */
  noteTypesChanged(): void {
    if (this.active) this.workspace.setNoteTypes(this.settings.noteTypes);
  }

  /** A note appeared in a note destination while an agent that may write there was working: one Activity line. */
  private async noteCreated(path: string): Promise<void> {
    if (!this.store || !this.chat || !path.endsWith('.md')) return;
    const writers = this.chat.writersFor(path);
    if (writers.length === 0) return;
    try {
      await appendActivityLine(
        this.store,
        this.store.root,
        `${writers.join(', ')}: note created \`${path}\``,
      );
    } catch (error) {
      this.workspace.reportError(error);
    }
  }

  async refreshM365(): Promise<void> {
    this.m365Connected = await m365IsConnected();
    if (this.active)
      this.workspace.setM365Status({
        connected: this.m365Connected,
        account: this.settings.m365Account || undefined,
        needsPermission: this.m365Connected && (await needsNewPermission()),
      });
  }
  /**
   * Starts Microsoft's device sign-in. The owner opens Microsoft's page and types the code there; this plugin never
   * sees a password. Resolves when the sign-in is finished or cancelled.
   */
  async connectM365(): Promise<void> {
    const clientId = this.settings.m365ClientId || DEFAULT_M365_CLIENT_ID;
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clientId))
      throw Error(
        'Enter the Application (client) ID of your Microsoft app registration first.',
      );
    this.m365Signin?.abort();
    const controller = new AbortController();
    this.m365Signin = controller;
    const authority = this.settings.m365Authority;
    const code = await startDeviceCode(clientId, authority, obsidianFetch);
    const modal = new M365SignInModal(this.app, code, () => controller.abort());
    modal.open();
    try {
      await finishDeviceCode(code, clientId, authority, {
        signal: controller.signal,
        f: obsidianFetch,
      });
      modal.setStatus('Approved. Reading your account name…');
      const label = await m365AccountLabel({ f: obsidianFetch });
      this.settings.m365Account = label;
      await this.saveSettings();
      modal.setStatus(
        label ? `Connected as ${label}` : 'Connected (name unavailable)',
        true,
      );
    } catch (error) {
      // Closing the window cancels on purpose; anything else is shown in the window and reported.
      if (controller.signal.aborted) return;
      modal.setStatus(
        error instanceof Error ? error.message : 'The sign-in failed.',
        true,
      );
      throw error;
    } finally {
      if (this.m365Signin === controller) this.m365Signin = null;
      await this.refreshM365();
    }
  }
  cancelM365Signin(): void {
    this.m365Signin?.abort();
  }
  /** Removes the saved token. Access granted at Microsoft stays until the owner removes it in their account. */
  async disconnectM365(): Promise<void> {
    await m365Disconnect();
    this.settings.m365Account = '';
    await this.saveSettings();
    await this.refreshM365();
  }

  async refreshBrowserTools(): Promise<void> {
    const status =
      this.settings.browserEngine === 'hermes'
        ? {
            engine: 'hermes' as const,
            available: false,
            hint: this.chat?.getSnapshot().runtimes.hermes?.available
              ? browserUnavailableReason('hermes', false, 'hermes')
              : 'Hermes is not installed or available; install Hermes with ACP support. Browser isolation is not yet verified.',
          }
        : await browserToolsStatus();
    if (this.active) this.workspace.setBrowserStatus(status);
  }
  async setupBrowserTools(): Promise<void> {
    if (this.settings.browserEngine !== 'playwright')
      throw Error(browserUnavailableReason('hermes', false, 'hermes'));
    if (
      !(await confirmAction(
        this.app,
        'Download browser tools?',
        'Allow a download of up to 500 MB for pinned Playwright MCP 0.0.83 and Chromium (typically about 200–300 MB; existing browser cache is reused)? No saved browser profile or login is imported.',
      ))
    )
      return;
    new Notice('Setting up browser tools…');
    await installBrowserTools();
    await this.refreshBrowserTools();
    new Notice(
      'Browser tools are ready. Enable Can use browser in the agent Setup.',
    );
  }
  /** Switches this plugin off and on through Obsidian's plugin manager, so nothing keeps using an old root. */
  async reloadPlugin(): Promise<void> {
    const plugins = (
      this.app as unknown as {
        plugins: {
          disablePlugin(id: string): Promise<void>;
          enablePlugin(id: string): Promise<void>;
        };
      }
    ).plugins;
    await plugins.disablePlugin(PLUGIN_ID);
    await plugins.enablePlugin(PLUGIN_ID);
  }
  /** After the team folder is renamed: keeps it hidden from search and the graph if it was. */
  renameHiddenFolder(from: string, to: string): void {
    if (!isFolderHidden(this.vaultConfig(), `${from}/`)) return;
    setFolderHidden(this.vaultConfig(), `${from}/`, false);
    setFolderHidden(this.vaultConfig(), `${to}/`, true);
  }
  /** Obsidian keeps "Excluded files" in the vault config; these two calls are not in the public typings. */
  private vaultConfig() {
    return this.app.vault as unknown as {
      getConfig(key: string): unknown;
      setConfig(key: string, value: unknown): void;
    };
  }
  async saveSettings(): Promise<void> {
    await this.persistPluginData();
    if (this.runtimeRefreshTimer !== null) {
      window.clearTimeout(this.runtimeRefreshTimer);
      this.runtimeRefreshTimer = null;
    }
    if (
      this.chat &&
      this.settings.runtimePathOverride !== this.runtimePathOverride
    ) {
      this.runtimeRefreshTimer = window.setTimeout(() => {
        this.runtimeRefreshTimer = null;
        if (!this.active || !this.chat) return;
        this.runtimePathOverride = this.settings.runtimePathOverride;
        void this.chat
          .setRuntimeAdapters(this.createAdapters())
          .catch((error: unknown) => this.workspace.reportError(error));
      }, 400);
    }
  }

  private async persistPluginData(
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const operation = this.dataQueue.then(async () => {
      const stored: unknown = await this.loadData();
      const otherData =
        stored !== null && typeof stored === 'object' && !Array.isArray(stored)
          ? stored
          : {};
      await this.saveData({ ...otherData, ...extra, ...this.settings });
    });
    this.dataQueue = operation.catch(() => undefined);
    await operation;
  }

  private isManaged(path: string): boolean {
    return (
      this.store !== null &&
      (path === this.store.root || path.startsWith(`${this.store.root}/`))
    );
  }

  private requestTeamRefresh(): void {
    if (!this.active || !this.store) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.workspace.refresh();
      this.chatRefresh = this.chatRefresh
        .then(async () => {
          if (this.active) await this.chat?.refreshAgents();
        })
        .catch((error: unknown) => this.workspace.reportError(error));
    }, 75);
  }

  private async noteLink(path: string, source: string): Promise<string> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new Error('Linked note is missing.');
    return `[[${this.app.metadataCache.fileToLinktext(file, source, true)}]]`;
  }

  /**
   * "Re-run safety check": forgets every stored safety result, so a blocked or unsupported version is checked
   * again on the next detection, then runs the setup check.
   */
  private async rerunSafetyChecks(): Promise<ToolCheck[]> {
    clearSafetyChecks(this.settings.selfTests);
    this.setupCache = null;
    await this.saveSettings();
    return this.checkSetupCached();
  }

  /** The setup check, reused for a minute so Obi's replies do not start every tool again. */
  private async checkSetupCached(): Promise<ToolCheck[]> {
    if (this.setupCache && Date.now() - this.setupCache.at < 60_000)
      return this.setupCache.checks;
    const checks = await checkSetup(this.createAdapters());
    this.setupCache = { at: Date.now(), checks };
    return checks;
  }

  private createAdapters() {
    if (!this.store || !(this.app.vault.adapter instanceof FileSystemAdapter))
      throw new Error('A local desktop vault is required to run agents.');
    return createRuntimeAdapters({
      runtimePathOverride: this.settings.runtimePathOverride,
      vaultBasePath: this.app.vault.adapter.getBasePath(),
      managedRoot: this.store.root,
      developerMode: this.settings.developerMode,
      configDir: this.app.vault.configDir,
      selfTests: this.settings.selfTests,
      rememberSelfTest: (key, record) => {
        // Written into the same object the adapters read, then saved with the other settings.
        this.settings.selfTests[key] = record;
        void this.saveSettings();
      },
    });
  }

  /** True when `<folder>/Agents` holds an agent note (frontmatter `agenthq: agent`). */
  private async folderHasTeam(folder: string): Promise<boolean> {
    const agents = this.app.vault.getFolderByPath(`${folder}/Agents`);
    for (const child of agents?.children ?? []) {
      if (!(child instanceof TFile) || child.extension !== 'md') continue;
      const text = await this.app.vault.cachedRead(child);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
      if (/^agenthq:\s*agent\s*$/m.test(frontmatter)) return true;
    }
    return false;
  }

  /** The configured team folder is missing but another one holds a team: ask, and create nothing. */
  private offerTeamFolder(configured: string, found: string): void {
    const notice = new Notice(
      createFragment((fragment) => {
        fragment.createSpan({
          text: `Your team folder ${configured} was not found; found a team in ${found}. Use ${found}? `,
        });
        fragment.createEl('button', { text: `Use ${found}` }).onclick = () => {
          this.settings.agenthqFolder = found;
          void this.saveSettings().then(() => {
            notice.hide();
            new Notice(`Now using ${found}. Reload the plugin to start.`);
          });
        };
      }),
      0,
    );
  }

  private async initializeNotes(): Promise<void> {
    try {
      const decision = await decideTeamFolder(this.settings.agenthqFolder, {
        exists: (path) => this.app.vault.adapter.exists(path),
        hasTeam: (folder) => this.folderHasTeam(folder),
      });
      if (decision.action === 'offer') {
        this.offerTeamFolder(decision.folder, decision.found);
        return;
      }
      this.store = new ObsidianStore(this.app, this.settings.agenthqFolder, {
        read: async (): Promise<unknown> => this.loadData(),
        write: async (data): Promise<void> => {
          await this.persistPluginData({ layout: data.layout });
        },
      });
      const created = await initializeStarterTeam(this.store, this.store.root);
      await ensureAgentHqFolders(this.store, this.store.root);
      await syncGuideNote(this.store, this.store.root);
      await ensureNoteSkills(this.store, this.store.root);
      if (!this.active) return;
      // Obi is created once per vault; a deleted Obi is restored only from Settings.
      const obiCreated =
        !this.settings.obiSeeded &&
        (await ensureObi(this.store, this.store.root));
      if (!this.settings.obiSeeded) {
        this.settings.obiSeeded = true;
        await this.saveSettings();
      }
      await this.workspace.initialize(this.store);
      if (obiCreated) await this.workspace.setPinned(OBI_ID, true);
      // The welcome tour starts in Obi's Chat until it is finished, declined, or postponed.
      if (!this.settings.tourDone) this.workspace.selectAgent(OBI_ID, 'chat');
      if (!(this.app.vault.adapter instanceof FileSystemAdapter))
        throw new Error('A local desktop vault is required to run agents.');
      const base = this.app.vault.adapter.getBasePath();
      const index = new VaultIndex(
        this.app,
        this.store.root,
        this.app.vault.configDir,
      );
      this.vaultIndex = index;
      // The vault map is rebuilt on start, and a few minutes after the vault changes.
      void this.writeVaultMap().catch((error: unknown) =>
        this.workspace.reportError(error),
      );
      this.registerEvent(
        this.app.vault.on('create', (file) => this.vaultChanged(file.path)),
      );
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          this.vaultChanged(file.path);
          this.mapRemoved(file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          this.vaultChanged(file.path);
          this.mapRemoved(oldPath);
        }),
      );
      this.registerEvent(
        this.app.vault.on('modify', (file) => this.vaultChanged(file.path)),
      );
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          void this.noteCreated(file.path);
        }),
      );
      this.chat = new ChatService({
        store: this.store,
        m365: {
          helper: join(
            base,
            this.app.vault.configDir,
            'plugins',
            PLUGIN_ID,
            'm365_mcp.cjs',
          ),
          connected: () => this.m365Connected,
          fetch: obsidianFetch,
        },
        vaultSnippets: () => index.passagesNow(),
        adapters: this.createAdapters(),
        settings: () => this.settings,
        setupCheck: () => this.checkSetupCached(),
        loadInbox: async () => {
          const data: unknown = await this.loadData();
          return data !== null && typeof data === 'object' && 'inbox' in data
            ? data.inbox
            : [];
        },
        saveInbox: async (inbox) => this.persistPluginData({ inbox }),
        vaultBasePath: base,
        managedRoot: this.store.root,
        configDir: this.app.vault.configDir,
        canonicalPath: async (path) => {
          // Inspect filesystem metadata only; note contents always use Vault APIs.
          // Resolve existing ancestors too: a not-yet-created workdir may be below a junction.
          const suffix: string[] = [];
          let cursor = path;
          for (;;) {
            try {
              return join(await realpath(cursor), ...suffix);
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
                dirname(cursor) === cursor
              )
                throw error;
              suffix.unshift(basename(cursor));
              cursor = dirname(cursor);
            }
          }
        },
        prepareDirectory: async (path) => {
          const rel = relative(await realpath(base), path);
          if (
            isAbsolute(rel) ||
            rel === '..' ||
            rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
          ) {
            // Outside-vault workdirs must already exist. Never write outside via raw fs.
            await realpath(path);
            return;
          }
          let folder = '';
          for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
            folder = folder ? `${folder}/${segment}` : segment;
            if (!this.app.vault.getAbstractFileByPath(folder))
              await this.app.vault.createFolder(folder);
          }
        },
        agentLink: (path, sourcePath) => this.noteLink(path, sourcePath),
        noteLink: (path, sourcePath) => this.noteLink(path, sourcePath),
      });
      this.workspace.attachChat(this.chat, this.settings.developerMode);
      this.register(() => {
        void this.chat
          ?.dispose()
          .catch((error: unknown) => this.workspace.reportError(error));
      });
      await this.chat.initialize();
      await this.refreshBrowserTools();
      await this.refreshM365();
      this.noteTypesChanged();
      if (!this.active) {
        await this.chat.dispose();
        return;
      }
      if (created && this.active) {
        const welcome = this.app.vault.getFileByPath(
          `${this.store.root}/Welcome.md`,
        );
        if (welcome) await this.app.workspace.getLeaf('tab').openFile(welcome);
      }
    } catch (error) {
      if (this.active) {
        this.workspace.setError(error);
      }
    }
  }

  /** The graph analysis for the overview, from the same link data as the map; null until the vault index exists. */
  private overviewAnalysis(): GraphAnalysis | null {
    if (!this.store || !this.vaultIndex) return null;
    return analyseLinkGraph(
      buildLinkGraph(
        this.vaultIndex.mapFiles(),
        this.app.metadataCache.resolvedLinks,
        this.store.root,
        this.app.vault.configDir,
      ),
    );
  }

  /** Opens a note from the overview in a new tab. */
  private openNote(path: string): void {
    const file = this.app.vault.getFileByPath(path);
    if (file) void this.app.workspace.getLeaf('tab').openFile(file);
  }

  /** A deleted or moved map is rebuilt at once, so it comes back in its place. */
  private mapRemoved(path: string): void {
    if (!this.store || !this.vaultIndex) return;
    void rebuildMapAfterRemoval({
      path,
      root: this.store.root,
      mapNames: [VAULT_MAP_NAME, GRAPH_MAP_NAME],
      guard: this.teamFolderGuard,
      exists: (folder) => this.app.vault.adapter.exists(folder),
      rebuild: () => this.writeVaultMap(),
    }).catch((error: unknown) => this.workspace.reportError(error));
  }

  /** Rebuilds the vault map a few minutes after the vault last changed; Mesa's own files do not count. */
  private vaultChanged(path: string): void {
    if (
      this.teamFolderGuard.active ||
      !this.store ||
      !isVaultSearchable(path, this.store.root, this.app.vault.configDir)
    )
      return;
    if (this.mapTimer !== null) return;
    this.mapTimer = window.setTimeout(() => {
      this.mapTimer = null;
      this.writeVaultMap().catch((error: unknown) =>
        this.workspace.reportError(error),
      );
    }, VAULT_MAP_DELAY_MS);
  }

  private async writeVaultMap(): Promise<void> {
    if (!this.store || !this.vaultIndex || this.teamFolderGuard.active) return;
    // Never bring back a team folder that no longer exists (it was renamed or moved away).
    if (!(await this.app.vault.adapter.exists(this.store.root))) return;
    const files = this.vaultIndex.mapFiles();
    await syncVaultMap(
      this.store,
      this.store.root,
      files,
      this.app.vault.configDir,
    );
    const analysis = analyseLinkGraph(
      buildLinkGraph(
        files,
        this.app.metadataCache.resolvedLinks,
        this.store.root,
        this.app.vault.configDir,
      ),
    );
    await this.writeGraph(analysis, files);
    // The AI pass is off by default. It adds to the graph map only, and it is read once per changed note.
    if (this.settings.graphAi && this.graphAiAbort === null)
      void this.runGraphAi(analysis, files);
  }

  /** Writes the graph map. The AI section is included only while the pass is on. */
  private async writeGraph(
    analysis: GraphAnalysis,
    files: VaultFile[],
  ): Promise<void> {
    if (!this.store) return;
    const root = this.store.root;
    const live = new Set(files.map((file) => file.path));
    const aiLines = this.settings.graphAi
      ? graphAiSection(
          this.graphAi,
          { ...this.graphAiSession, costUsd: this.graphAiTotal },
          live,
        )
      : [];
    await syncGraphMap(this.store, root, renderGraphMap(analysis, aiLines));
  }

  /**
   * One pass of the optional AI concepts check: up to a few low-link notes that have not been read at their current
   * modified time. Each reply is verified against real paths and note text before it reaches the map.
   */
  private async runGraphAi(
    analysis: GraphAnalysis,
    files: VaultFile[],
  ): Promise<void> {
    if (!this.store) return;
    const controller = new AbortController();
    this.graphAiAbort = controller;
    try {
      if (!this.graphAiLoaded) {
        const kept = await loadGraphConcepts(this.store, this.store.root);
        this.graphAi = kept.results;
        this.graphAiTotal = kept.totalCostUsd;
        this.graphAiLoaded = true;
      }
      const mtimes = new Map(files.map((file) => [file.path, file.mtime]));
      const candidates = graphAiCandidates(analysis, mtimes, this.graphAi);
      const result = await runGraphAiPass(
        candidates,
        new Set(files.map((file) => file.path)),
        this.graphAi,
        {
          readNote: async (path) => {
            const file = this.app.vault.getFileByPath(path);
            return file
              ? stripFrontmatter(await this.app.vault.cachedRead(file))
              : null;
          },
          ask: (prompt) =>
            this.chat
              ? this.chat.graphConceptRun(prompt, controller.signal)
              : Promise.resolve(null),
          signal: controller.signal,
        },
      );
      this.graphAiSession.checked += result.checked;
      this.graphAiSession.dropped += result.dropped;
      this.graphAiTotal += result.costUsd;
      this.graphAiStatus = result.skipped
        ? `The last pass stopped: ${result.skipped}.`
        : `The last pass read ${result.checked} notes.`;
      await saveGraphConcepts(this.store, this.store.root, {
        totalCostUsd: this.graphAiTotal,
        results: this.graphAi,
      });
      await appendActivityLine(
        this.store,
        this.store.root,
        graphActivityLine(result, this.graphAiTotal),
      );
      await this.writeGraph(analysis, files);
    } catch (error) {
      this.workspace.reportError(error);
    } finally {
      this.graphAiAbort = null;
    }
  }

  onunload(): void {
    this.active = false;
    this.graphAiAbort?.abort();
    if (this.mapTimer !== null) window.clearTimeout(this.mapTimer);
    this.workspace.dispose();
    void this.chat
      ?.dispose()
      .catch((error: unknown) => this.workspace.reportError(error));
    for (const type of [
      GRAPH_VIEW,
      VAULT_OVERVIEW_VIEW,
      AGENT_VIEW,
      TEAM_VIEW,
      PROJECTS_VIEW,
      SCHEDULES_VIEW,
      SKILLS_VIEW,
    ]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (
          leaf.view instanceof GraphView ||
          leaf.view instanceof VaultOverviewView ||
          leaf.view instanceof AgentPanel ||
          leaf.view instanceof TeamPanel ||
          leaf.view instanceof ProjectsPanel ||
          leaf.view instanceof SchedulesPanel ||
          leaf.view instanceof SkillsPanel
        )
          leaf.view.unmount();
      }
    }
  }
}
