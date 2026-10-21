/* eslint obsidianmd/prefer-window-timers: off -- Core runs in plain Node tests, where there is no window; the timers only debounce memory work. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphAiRefusal, type GraphAiReplyOrRefusal } from './graphAi';
import { imagePrompt } from './images';
import { commandsAsk, commandsOffered } from './runtimes/ids';
import {
  agentNoteTypes,
  destinationFolders,
  existingNoteNames,
  noteDestinationsSection,
  noteSkillText,
  type NoteType,
} from './noteTypes';
import {
  m365UnavailableReason,
  prepareM365Run,
  type PreparedM365,
} from './m365/launch';
import { buildSystemPrompt } from './prompt';
import type { ToolCheck } from './setupCheck';
import {
  DEFAULT_CONTEXT_LEVEL,
  assignedAgentIds,
  loadValidProjects,
  parseProject,
  projectPromptSection,
  type MemoryChoice,
  type Project,
} from './projects';
import { agentOutsideFolders, outputFolderProblem } from './folders';
import {
  hasVaultAccess,
  vaultMapInstruction,
  vaultSearchSection,
} from './vaultMap';
import {
  appendLogLines,
  extractionPrompt,
  LOG_TAIL_ENTRIES,
  logEntries,
  logNotePath,
  MEMORY_INSTRUCTION,
  memoryCostFromLog,
  memoryNotesFolder,
  parseMemoryBlocks,
  rankSnippets,
  RETRIEVAL_CAP_WORDS,
  resolveMemoryRuntime,
  saveMemoryItems,
  type Snippet,
  taskLogEntry,
  truncateWords,
  wordCount,
} from './memory';
import { OBI_ID, obiPrompt, parseObiProposals, type ObiProposal } from './obi';
import {
  Orchestrator,
  type InboxItem,
  type RequestContext,
  type TaskNote,
} from './orchestrator';
import { chatRecallSection, isRecallRequest } from './chatRecall';
import type { ContextUse, PlanUsage } from './context';
import { chatExcerpt } from './mentions';
import { chatFacts, projectSpendUsd, taskFacts } from './projectBoard';
import {
  dueDecision,
  followingRun,
  loadValidSchedules,
  resumeSchedule as resumeScheduleNote,
  type Schedule,
  type ScheduleFields,
} from './schedules';
import {
  clampRounds,
  loopSummary,
  runLoop,
  type LoopResult,
  type LoopSpec,
  type LoopTurn,
} from './loops';
import type { Agent, ChatMessage, Skill } from './model';
import type { NoteDocument } from './notes';
import type { Store } from './store';
import type {
  BroadcastRecipient,
  BroadcastSnapshot,
  BroadcastTarget,
} from './broadcast';
import { RunQueue } from './queue';
import { FULL_PERMISSION_WARNING } from './permissions';
import { resolveWorkdir } from './workdir';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
  RuntimeStatus,
} from './runtimes/types';

export type ChatStatus =
  'idle' | 'offline' | 'queued' | 'working' | 'needs-you' | 'error';
/** How much of the main conversation a side chat gets as context. */
const SIDE_CONTEXT_CHARS = 6000;

/** Total tokens of a run that reported tokens, or undefined. */
function totalTokens(tokens?: { input: number; output: number }) {
  return tokens ? tokens.input + tokens.output : undefined;
}
export interface ChatEntry extends ChatMessage {
  tools: { name: string; summary: string }[];
  streaming?: boolean;
  cancelled?: boolean;
}
/** Runtimes with a native fork: verified in their installed help (Claude Code --fork-session, Codex exec fork). */
const NATIVE_FORK_RUNTIMES = new Set(['claude-code', 'codex']);

export interface ChatSession {
  sessionId: string;
  /** Sessions belong to one adapter and must never be resumed by another. */
  runtimeId: string;
  path: string;
  started: string;
  costUsd: number;
  hasRun: boolean;
  carrySummary: string;
  titlePending?: boolean;
  title?: string;
  /** The project the session ran in; recorded in the chat note. */
  projectId?: string;
  /** Earlier messages carried over when the runtime cannot resume this session. */
  transcriptFallback?: string;
  /** Set on a fork: the chat it came from and the index of the message it was forked at. */
  forkedFrom?: { path: string; index: number };
  /** The next run is a native fork of the resumed session. Cleared once a run completes. */
  forkPending?: boolean;
}
export interface AgentChatSnapshot {
  agent: Agent;
  status: ChatStatus;
  hint?: string;
  session: ChatSession | null;
  messages: ChatEntry[];
  history: NoteDocument[];
  /** How much of the model's context the conversation uses, from the last reply; unset until a runtime reports it. */
  context?: ContextUse;
  /** Obi only: proposals awaiting the owner, and problems to report back on its next turn. */
  proposals?: ObiProposal[];
  obiNotes?: string[];
  /** Commands waiting for the owner's Approve or Reject (Run commands: Ask me each time). */
  commandApprovals?: {
    id: string;
    command: string;
    cwd?: string;
    /** Set for Microsoft 365 actions: what the card is about. */
    title?: string;
  }[];
}
export interface ChatSnapshot {
  /** The Claude Code plan's 5-hour and weekly usage, from the last run that reported it. */
  planUsage?: PlanUsage;
  broadcast?: BroadcastSnapshot;
  tasks?: NoteDocument[];
  inbox?: InboxItem[];
  agents: Record<string, AgentChatSnapshot>;
  runtimes: Record<string, RuntimeStatus>;
  queue: { running: number; queued: number };
  /** Loops running now, keyed by agent id: the round shown as Round k/N. */
  loops?: Record<string, { round: number; rounds: number }>;
}
export interface ChatServiceOptions {
  store: Store;
  /** Microsoft 365: where the helper is installed and whether the owner has connected an account. */
  m365?: {
    helper: string;
    connected: () => boolean | Promise<boolean>;
    /** The plugin's own HTTP (Obsidian's requestUrl), used for every Microsoft call made here. */
    fetch: typeof fetch;
    /** Tests only: replaces the real per-run preparation. */
    prepare?: typeof prepareM365Run;
  };
  adapters: RuntimeAdapter[];
  settings: () => {
    maxParallelRuns: number;
    allowedFolders: string[];
    maxDelegationDepth?: number;
    maxRunsPerRequest?: number;
    defaultVerifierAttempts?: number;
    browserEngine?: import('./browser').BrowserEngine;
    memoryModel?: MemoryChoice;
    graphAiModel?: string;
    noteTypes?: NoteType[];
  };
  /** Quiet time after the last finished task before memory extraction runs. */
  memoryDelayMs?: number;
  /** The setup check Obi reads when the owner asks what is missing. */
  setupCheck?: () => Promise<ToolCheck[]>;
  /** Passages of the vault notes (outside Mesa) for vault search; kept up to date by the plugin. */
  vaultSnippets?: () => Promise<Snippet[]>;
  vaultBasePath: string;
  managedRoot: string;
  configDir?: string;
  /** Return the full wikilink, using the host's link resolver. */
  agentLink?: (path: string, sourcePath: string) => Promise<string>;
  noteLink?: (path: string, sourcePath: string) => Promise<string>;
  prepareDirectory?: (absolutePath: string) => Promise<void>;
  canonicalPath?: (absolutePath: string) => Promise<string>;
  onChange?: (snapshot: ChatSnapshot) => void;
  loadInbox?: () => Promise<unknown>;
  saveInbox?: (items: InboxItem[]) => Promise<void>;
}

interface TurnResult {
  status: BroadcastRecipient['status'];
  reason?: string;
  error?: Error;
  text?: string;
}

function localTime(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Claude-style title: the first eight words of the first message, no AI call. */
export function chatTitle(text: string): string {
  return text.trim().split(/\s+/).slice(0, 8).join(' ');
}

/** New notes are named "<title> — <agent> — YYYY-MM-DD HHMM". */
function chatBasename(
  started: string,
  agentName: string,
  title: string,
): string {
  const date = new Date(started);
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const safe = (value: string) =>
    Array.from(value)
      .filter((character) => character.charCodeAt(0) >= 32)
      .join('')
      .replace(/[<>:"/\\|?*#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80);
  return `${safe(title) || 'New conversation'} — ${safe(agentName)} — ${day} ${localTime(started).replace(':', '')}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Saved title, or the first message for notes made before titles existed. */
export function conversationTitle(note: NoteDocument): string {
  const fm = record(note.frontmatter);
  if (typeof fm.title === 'string' && fm.title) return fm.title;
  const first = readMessages(note.body).find(
    (message) => message.role === 'user',
  );
  return (first && chatTitle(first.content)) || note.name;
}

/** A chat note as an @mention attaches it: its title and its last messages. */
export function chatMention(note: NoteDocument): {
  content: string;
  truncated: boolean;
} {
  return chatExcerpt(conversationTitle(note), readMessages(note.body));
}

/** Hidden per-message metadata makes arbitrary Markdown unambiguous without duplicating text in frontmatter. */
function readMessages(body: string): ChatEntry[] {
  const messages: ChatEntry[] = [];
  const marker = /^<!-- agenthq-message (.+) -->\n### [^\n]*\n\n/gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(body))) {
    try {
      const metadata = record(JSON.parse(match[1]!));
      const length = metadata.contentLength;
      if (
        (metadata.role !== 'user' && metadata.role !== 'assistant') ||
        typeof metadata.timestamp !== 'string' ||
        typeof length !== 'number' ||
        !Number.isInteger(length) ||
        length < 0 ||
        marker.lastIndex + length > body.length
      )
        continue;
      const tools = Array.isArray(metadata.tools)
        ? metadata.tools.flatMap((item: unknown) => {
            const tool = record(item);
            return typeof tool.name === 'string' &&
              typeof tool.summary === 'string'
              ? [{ name: tool.name, summary: tool.summary }]
              : [];
          })
        : [];
      messages.push({
        role: metadata.role,
        timestamp: metadata.timestamp,
        content: body.slice(marker.lastIndex, marker.lastIndex + length),
        tools,
        ...(typeof metadata.costUsd === 'number'
          ? { costUsd: metadata.costUsd }
          : {}),
        ...(typeof metadata.tokens === 'number'
          ? { tokens: metadata.tokens }
          : {}),
        ...(metadata.cancelled === true ? { cancelled: true } : {}),
      });
      marker.lastIndex +=
        length +
        (typeof metadata.tailLength === 'number' && metadata.tailLength >= 0
          ? metadata.tailLength
          : 0);
    } catch {
      /* Malformed manually edited history must not prevent startup. */
    }
  }
  if (messages.length) return messages;
  return [
    ...body.matchAll(
      /^### (.+?) · ([^\n]+)\n\n([\s\S]*?)(?=\n\n### |\n\n## Summary|$)/gm,
    ),
  ].map((match) => ({
    role: match[1] === 'You' ? 'user' : 'assistant',
    timestamp: match[2]!,
    content: match[3]!,
    tools: [],
  }));
}

export class ChatService {
  private readonly queue: RunQueue;
  private readonly orchestrator: Orchestrator;
  private readonly taskStates = new Map<string, AgentChatSnapshot>();
  private readonly taskNotes = new WeakMap<
    AgentChatSnapshot,
    { note: TaskNote; verification: boolean }
  >();
  private readonly taskPersisted = new WeakMap<
    AgentChatSnapshot,
    Set<ChatEntry>
  >();
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private readonly states: Record<string, AgentChatSnapshot> = {};
  private readonly pending = new Map<string, number>();
  private readonly closing = new Set<string>();
  private disposed = false;
  private stopGeneration = 0;
  private readonly agentStopGeneration = new Map<string, number>();
  private refreshGeneration = 0;
  private runtimes: Record<string, RuntimeStatus> = {};
  private readonly detections = new Map<string, Promise<RuntimeStatus>>();
  private broadcastResult?: BroadcastSnapshot;
  private broadcasting = false;
  private readonly memoryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly memoryPending = new Map<
    string,
    { title: string; text: string }[]
  >();
  private memoryWrites: Promise<void> = Promise.resolve();
  private readonly memoryTokens = new Map<
    string,
    { text: string; tokens: string[] }
  >();
  private readonly recallTokens = new Map<
    string,
    { text: string; tokens: string[] }
  >();
  private readonly passageTokens = new Map<
    string,
    { text: string; tokens: string[] }
  >();
  private readonly lastContextWords = new Map<string, number>();
  /** Set while a schedule tick runs; a tick that starts meanwhile does nothing. */
  private ticking = false;
  private planUsage: PlanUsage | undefined;
  private readonly loops = new Map<
    string,
    {
      stopped: boolean;
      verifierId?: string;
      progress: { round: number; rounds: number };
    }
  >();
  constructor(private readonly options: ChatServiceOptions) {
    this.queue = new RunQueue(() => options.settings().maxParallelRuns);
    this.orchestrator = new Orchestrator({
      store: options.store,
      settings: options.settings,
      managedRoot: options.managedRoot,
      noteLink: options.noteLink,
      agents: () => Object.values(this.states).map((state) => state.agent),
      changed: () => this.publish(),
      loadInbox: () => options.loadInbox?.() ?? Promise.resolve([]),
      saveInbox: (items) => options.saveInbox?.(items) ?? Promise.resolve(),
      chatPath: (id) => this.states[id]?.session?.path,
      needsYou: (id, reason) => {
        // Active inbox records project needs-you in getSnapshot, including after reload.
        void id;
        void reason;
      },
      turn: (id, text, request, task, verification) =>
        this.sendTurn(id, text, request, task, verification),
      taskFinished: (note, worker, request) =>
        this.taskFinished(note, worker, request),
    });
    if (options.onChange) this.listeners.add(options.onChange);
  }

  async initialize(): Promise<void> {
    const attachments = `${this.options.managedRoot}/Attachments`;
    if (!(await this.options.store.exists(attachments)))
      await this.options.store.createFolder(attachments);
    const { agents } = await this.options.store.loadAgents();
    for (const agent of agents)
      this.states[agent.id] = {
        agent,
        status: 'offline',
        session: null,
        messages: [],
        history: [],
      };
    const chats = await this.options.store.loadChats();
    for (const state of Object.values(this.states)) {
      state.history = chats
        .filter((note) => {
          const fm = record(note.frontmatter);
          return fm.agenthq === 'chat' && fm.agentId === state.agent.id;
        })
        .sort((a, b) =>
          String(record(a.frontmatter).started).localeCompare(
            String(record(b.frontmatter).started),
          ),
        );
      const current = state.history
        .filter((note) => record(note.frontmatter).closed !== true)
        .at(-1);
      if (current) {
        const fm = record(current.frontmatter);
        if (
          typeof fm.sessionId === 'string' &&
          typeof fm.started === 'string'
        ) {
          state.session = {
            sessionId: fm.sessionId,
            runtimeId: typeof fm.runtimeId === 'string' ? fm.runtimeId : '',
            path: current.path,
            started: fm.started,
            costUsd: typeof fm.costUsd === 'number' ? fm.costUsd : 0,
            hasRun: fm.hasRun !== false,
            titlePending: fm.titlePending === true,
            title: typeof fm.title === 'string' ? fm.title : undefined,
            carrySummary:
              typeof fm.carrySummary === 'string' ? fm.carrySummary : '',
          };
          state.messages = readMessages(current.body);
        }
      } else {
        // A crash or failed write between closing and saving the replacement
        // must not discard the summary carried into the next conversation.
        const latest = record(state.history.at(-1)?.frontmatter);
        if (latest.closed === true && typeof latest.summary === 'string') {
          state.session = this.createSession(state);
          state.session.carrySummary = latest.summary;
        }
      }
    }
    await this.orchestrator.initialize();
    await this.refreshRuntimes();
  }

  async setRuntimeAdapters(adapters: RuntimeAdapter[]): Promise<void> {
    this.options.adapters = adapters;
    await this.refreshRuntimes();
  }

  /** Explicit discovery (startup, path changes, or a caller requesting a refresh). */
  async refreshRuntimes(): Promise<void> {
    await this.refreshAgents(true);
  }

  /** Note refreshes reuse cached detection unless an agent selects another runtime. */
  async refreshAgents(forceDetection = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.refreshGeneration;
    const { agents } = await this.options.store.loadAgents();
    if (this.disposed || generation !== this.refreshGeneration) return;
    const changedRuntimes = new Set<string>();
    for (const agent of agents) {
      if (this.states[agent.id]?.agent.runtime !== agent.runtime)
        changedRuntimes.add(agent.runtime);
      if (this.states[agent.id]) this.states[agent.id]!.agent = agent;
      else
        this.states[agent.id] = {
          agent,
          status: 'offline',
          session: null,
          messages: [],
          history: [],
        };
    }
    for (const id of Object.keys(this.states)) {
      if (!agents.some((agent) => agent.id === id)) {
        await this.queue.cancel(id);
        delete this.states[id];
      }
    }
    for (const adapter of this.options.adapters) {
      if (forceDetection || changedRuntimes.has(adapter.id))
        await this.detectRuntime(adapter, forceDetection);
    }
    if (this.disposed || generation !== this.refreshGeneration) return;
    this.updateAvailability();
  }

  private async detectRuntime(
    adapter: RuntimeAdapter,
    force = false,
  ): Promise<void> {
    let detection = force ? undefined : this.detections.get(adapter.id);
    if (!detection) {
      detection = Promise.resolve()
        .then(() => adapter.detect())
        .catch(() => ({
          available: false,
          hint: 'Runtime detection failed. Check the executable path in Settings.',
        }));
      this.detections.set(adapter.id, detection);
    }
    const status = await detection;
    // A newer explicit refresh supersedes an in-flight result for this runtime.
    if (this.disposed || this.detections.get(adapter.id) !== detection) return;
    this.detections.delete(adapter.id);
    this.runtimes[adapter.id] = status;
    this.updateAvailability();
  }

  private updateAvailability(): void {
    for (const state of Object.values(this.states)) {
      if (['working', 'queued', 'needs-you', 'error'].includes(state.status))
        continue;
      const runtime = this.runtimes[state.agent.runtime];
      state.status = runtime?.available ? 'idle' : 'offline';
      state.hint =
        runtime?.hint ??
        (runtime?.available
          ? undefined
          : 'Runtime unavailable. Install and sign in to the selected runtime, then refresh.');
    }
    this.publish();
  }

  getSnapshot(): ChatSnapshot {
    const agents = { ...this.states };
    for (const state of this.taskStates.values()) {
      const current = agents[state.agent.id];
      if (
        current &&
        (state.status === 'working' ||
          (state.status === 'queued' && current.status !== 'working'))
      )
        agents[state.agent.id] = { ...current, status: state.status };
    }
    for (const item of this.orchestrator.inbox) {
      if (item.resolved) continue;
      const current = agents[item.agentId];
      if (current?.status === 'idle')
        agents[item.agentId] = {
          ...current,
          status: 'needs-you',
          hint: item.message,
        };
    }
    return structuredClone({
      agents,
      tasks: this.orchestrator.tasks,
      inbox: this.orchestrator.inbox,
      runtimes: this.runtimes,
      queue: this.queue.snapshot(),
      loops: Object.fromEntries(
        [...this.loops].map(([id, loop]) => [id, loop.progress]),
      ),
      ...(this.planUsage ? { planUsage: this.planUsage } : {}),
      ...(this.broadcastResult ? { broadcast: this.broadcastResult } : {}),
    });
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getSnapshot());
      } catch {
        /* A view failure must not strand an active runtime or break teardown. */
      }
    }
  }

  private state(id: string): AgentChatSnapshot {
    const state = this.states[id];
    if (!state) throw new Error(`Unknown agent: ${id}`);
    return state;
  }

  private createSession(
    state: AgentChatSnapshot,
    runtimeId = state.agent.runtime,
  ): ChatSession {
    state.context = undefined;
    const started = new Date().toISOString();
    const sessionId = randomUUID();
    return {
      sessionId,
      runtimeId,
      path: '',
      started,
      costUsd: 0,
      hasRun: false,
      carrySummary: '',
      titlePending: true,
    };
  }

  async broadcast(
    target: BroadcastTarget,
    text: string,
    projectId?: string,
  ): Promise<void> {
    if (this.disposed) throw new Error('Chat service is disposed');
    if (this.broadcasting) throw new Error('Broadcast is already in progress');
    if (!text.trim()) throw new Error('Message cannot be empty');
    this.broadcasting = true;
    const generation = this.stopGeneration;
    const agentGenerations = new Map(this.agentStopGeneration);
    try {
      const { agents, invalidAgents } = await this.options.store.loadAgents();
      if (
        target.kind === 'group' &&
        !(await this.options.store.loadGroups()).some(
          (group) => group.id === target.id,
        )
      )
        throw new Error(`Unknown group: ${target.id}`);
      if (
        target.kind === 'agent' &&
        !agents.some((agent) => agent.id === target.id)
      )
        throw new Error(`Unknown agent: ${target.id}`);
      const recipients = agents.filter(
        (agent) =>
          target.kind === 'everyone' ||
          (target.kind === 'group'
            ? agent.group === target.id
            : agent.id === target.id),
      );
      for (const agent of recipients) {
        if (this.states[agent.id]) this.states[agent.id]!.agent = agent;
        else
          this.states[agent.id] = {
            agent,
            status: 'idle',
            session: null,
            messages: [],
            history: [],
          };
      }
      const result: BroadcastSnapshot = {
        target: structuredClone(target),
        text,
        running: true,
        recipients: recipients.map((agent) => ({
          key: agent.path,
          agentId: agent.id,
          name: agent.name,
          status: 'sending',
        })),
      };
      if (target.kind === 'everyone')
        result.recipients.push(
          ...invalidAgents.map((agent) => ({
            key: agent.path,
            name: agent.name,
            status: 'skipped' as const,
            reason: agent.reason,
          })),
        );
      this.broadcastResult = result;
      this.publish();
      const budget = this.orchestrator.createBudget();
      await Promise.all(
        result.recipients.map(async (recipient) => {
          if (!recipient.agentId) return;
          if (
            this.disposed ||
            generation !== this.stopGeneration ||
            agentGenerations.get(recipient.agentId) !==
              this.agentStopGeneration.get(recipient.agentId)
          ) {
            recipient.status = 'cancelled';
            recipient.reason = 'Run cancelled';
            this.publish();
            return;
          }
          const turn = await this.orchestrator.request(
            recipient.agentId,
            text,
            budget,
            projectId,
          );
          recipient.status = turn.status as BroadcastRecipient['status'];
          recipient.reason = turn.reason;
          this.publish();
        }),
      );
      result.running = false;
      this.publish();
    } finally {
      this.broadcasting = false;
    }
  }

  async send(
    agentId: string,
    text: string,
    projectId?: string,
    unattended = false,
  ): Promise<void> {
    const refusal = projectId
      ? await this.projectLimitRefusal(projectId)
      : null;
    if (refusal) throw new Error(refusal);
    const result = await this.orchestrator.request(
      agentId,
      text,
      undefined,
      projectId,
      unattended,
    );
    if (result.error !== undefined) throw result.error;
  }

  async resolveInbox(
    id: string,
    action: 'accept' | 'retry' | 'cancel' | 'dismiss',
  ): Promise<void> {
    if (this.disposed) throw new Error('Chat service is disposed');
    const item = this.orchestrator.inbox.find((entry) => entry.id === id);
    // Resuming a held schedule from the Inbox resumes the schedule and clears the item.
    if (item?.kind === 'schedule-held' && action === 'retry' && item.path) {
      await this.resumeSchedule(item.path);
      await this.orchestrator.resolveInbox(id, 'dismiss');
      return;
    }
    await this.orchestrator.resolveInbox(id, action);
    for (const state of Object.values(this.states)) {
      if (
        state.status === 'needs-you' &&
        !this.orchestrator.inbox.some(
          (item) => !item.resolved && item.agentId === state.agent.id,
        )
      ) {
        state.status = this.runtimes[state.agent.runtime]?.available
          ? 'idle'
          : 'offline';
        state.hint = undefined;
      }
    }
    this.publish();
  }

  private async sendTurn(
    agentId: string,
    text: string,
    context?: RequestContext,
    task?: TaskNote,
    verification = false,
  ): Promise<TurnResult> {
    let outcome: TurnResult = { status: 'cancelled', reason: 'Run cancelled' };
    let failureStatus: 'skipped' | 'error' = 'skipped';
    let started = false;
    let workdirRefused = false;
    let m365Run: PreparedM365 | undefined;
    const checkedAdapters = new Set<RuntimeAdapter>();
    try {
      if (context?.stopped) return outcome;
      if (this.disposed) throw new Error('Chat service is disposed');
      if (this.closing.has(agentId))
        throw new Error('New conversation is already in progress');
      if (!text.trim()) throw new Error('Message cannot be empty');
      // Every project run (delegated tasks, verifier runs, loop rounds) waits behind the same cost check.
      const refusal = context?.projectId
        ? await this.projectLimitRefusal(context.projectId)
        : null;
      if (refusal)
        return { status: 'error', reason: refusal, error: new Error(refusal) };
      let state = this.state(agentId);
      if (task) {
        const key = `${task.path}:${verification ? 'verifier' : 'worker'}`;
        let isolated = this.taskStates.get(key);
        if (!isolated) {
          isolated = {
            agent: state.agent,
            status: 'idle',
            session: this.createSession(state),
            messages: [],
            history: [],
          };
          const prefix = verification ? 'verifier' : '';
          const field = (name: string) =>
            prefix ? prefix + name[0]!.toUpperCase() + name.slice(1) : name;
          const storedSession = task.frontmatter[field('sessionId')];
          isolated.session!.sessionId =
            typeof storedSession === 'string' ? storedSession : randomUUID();
          isolated.session!.hasRun = task.frontmatter[field('hasRun')] === true;
          isolated.session!.costUsd = Number(
            task.frontmatter[field('costUsd')] ?? 0,
          );
          const storedRuntime = task.frontmatter[field('runtimeId')];
          isolated.session!.runtimeId =
            typeof storedRuntime === 'string'
              ? storedRuntime
              : state.agent.runtime;
          this.taskStates.set(key, isolated);
          this.taskNotes.set(isolated, { note: task, verification });
        }
        isolated.agent = state.agent;
        state = isolated;
      }
      if (state.agent.permission === 'full')
        throw new Error(FULL_PERMISSION_WARNING);
      const adapter = this.options.adapters.find(
        (entry) => entry.id === state.agent.runtime,
      );
      if (adapter && !this.runtimes[state.agent.runtime]?.available) {
        checkedAdapters.add(adapter);
        await this.detectRuntime(adapter);
      }
      if (this.disposed || context?.stopped) return outcome;
      if (!adapter || !this.runtimes[state.agent.runtime]?.available)
        throw new Error(
          this.runtimes[state.agent.runtime]?.hint ?? 'Runtime unavailable',
        );
      await this.enqueue(state, async (queueSignal) => {
        const signal = context
          ? AbortSignal.any([queueSignal, context.controller.signal])
          : queueSignal;
        if (signal.aborted) return;
        const runTurn = async (
          adapter: RuntimeAdapter,
          request: RunRequest,
          signal: AbortSignal,
          onEvent: (event: RunEvent) => void,
        ) => {
          if (
            context &&
            !(await this.orchestrator.beforeRun(context, agentId, task?.path))
          )
            return null;
          const result = await this.run(adapter, request, signal, onEvent);
          if (task && result) {
            const costField = verification
              ? 'verifierTotalCostUsd'
              : 'workerTotalCostUsd';
            task.frontmatter[costField] =
              Number(task.frontmatter[costField] ?? 0) + (result.costUsd ?? 0);
          }
          return result;
        };
        started = true;
        try {
          const agent = state.agent;
          const adapter = this.options.adapters.find(
            (entry) => entry.id === agent.runtime,
          );
          if (
            adapter &&
            !this.runtimes[agent.runtime]?.available &&
            !checkedAdapters.has(adapter)
          ) {
            checkedAdapters.add(adapter);
            await this.detectRuntime(adapter);
          }
          if (signal.aborted) return;
          if (!adapter || !this.runtimes[agent.runtime]?.available)
            throw new Error('Runtime unavailable');
          const policy = await resolveWorkdir({
            agentId,
            configDir: this.options.configDir,
            workdir: agent.workdir,
            vaultAccess: agent.vaultAccess,
            vaultBasePath: this.options.vaultBasePath,
            managedRoot: this.options.managedRoot,
            allowedFolders: await this.runFolders(agent, context?.projectId),
            resolvePath: this.options.canonicalPath,
          }).catch((error: unknown) => {
            workdirRefused = true;
            throw error;
          });
          if (task && !verification)
            task.frontmatter.workerWorkdir = policy.cwd;
          failureStatus = 'error';
          if (signal.aborted) return;
          await this.options.prepareDirectory?.(policy.cwd);
          if (signal.aborted) return;
          if (state.session && state.session.runtimeId !== adapter.id) {
            await this.persist(state, { closed: true, summary: '' });
            if (signal.aborted) return;
            state.session = null;
            state.messages = [];
          }
          state.session ??= this.createSession(state, adapter.id);
          if (task) {
            task.frontmatter.status = verification ? 'verifying' : 'running';
            if (!verification && !task.frontmatter.attempt)
              task.frontmatter.attempt = 1;
          }
          state.messages.push({
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
            tools: [],
          });
          await this.persist(state);
          if (signal.aborted) return;
          const skills = await this.options.store.loadSkills();
          const agentList = Object.values(this.states).map(
            (entry) => entry.agent,
          );
          const groups = await this.options.store.loadGroups();
          const project = await this.projectFor(context?.projectId);
          if (project && state.session) state.session.projectId = project.id;
          const projectSection = projectPromptSection(
            project,
            agent.id,
            agentList,
            groups,
            skills,
          );
          const projectMemory =
            project && projectSection !== ''
              ? [
                  MEMORY_INSTRUCTION,
                  await this.projectMemorySection(project, agent.id, text),
                ]
              : [];
          const systemPrompt = [
            buildSystemPrompt(agent, agentList, skills),
            await this.vaultSection(agent, text),
            await this.recallSection(agent, text, state.session?.path),
            await this.destinationsSection(agent, skills),
            ...(agent.id === OBI_ID
              ? [
                  obiPrompt(agentList, groups, {
                    ...(await this.obiContext()),
                    setup: await this.options.setupCheck?.(),
                  }),
                ]
              : []),
            projectSection,
            ...projectMemory,
          ]
            .filter((section) => section !== '')
            .join('\n\n');
          if (signal.aborted) return;
          let assistant: ChatEntry = {
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            tools: [],
            streaming: true,
          };
          state.messages.push(assistant);
          state.status = 'working';
          this.publish();
          const notes = state.obiNotes?.length
            ? `Notes from Mesa about your last proposal:\n${state.obiNotes.map((note) => `- ${note}`).join('\n')}\n\n`
            : '';
          state.obiNotes = undefined;
          const prompt =
            notes +
            (!state.session.hasRun && state.session.carrySummary
              ? `Previous conversation summary:\n${state.session.carrySummary}\n\nUser message:\n${text}`
              : text);
          // Microsoft 365: a private token folder and outbox for this run; the owner's cards come from its outbox.
          if (
            agent.canUseM365 &&
            this.options.m365 &&
            m365UnavailableReason(agent.runtime, true) === '' &&
            (await this.options.m365.connected())
          )
            m365Run = await (this.options.m365.prepare ?? prepareM365Run)(
              this.options.m365.helper,
              (card) =>
                this.askCommand(
                  agentId,
                  agent.name,
                  { command: card.text, title: card.title },
                  signal,
                  context?.unattended === true || task !== undefined,
                ),
              { f: this.options.m365.fetch },
            );
          const request: RunRequest = {
            ...policy,
            ...(m365Run ? { m365Launch: m365Run.launch } : {}),
            webAccess: agent.webAccess ?? true,
            canUseBrowser: agent.canUseBrowser ?? false,
            browserEngine:
              this.options.settings().browserEngine ?? 'playwright',
            wholeComputerReadConfirmed:
              agent.wholeComputerReadConfirmed ?? false,
            browserReadsConfirmed: agent.browserReadsConfirmed ?? false,
            prompt: imagePrompt(
              prompt,
              this.options.managedRoot,
              this.options.vaultBasePath,
            ),
            systemPrompt,
            sessionId: state.session.sessionId,
            ...{ previousCostUsd: state.session.costUsd },
            resume: state.session.hasRun,
            forkSession: state.session.forkPending === true,
            permission: agent.permission,
            runCommands:
              agent.runCommands === 'allow' && commandsOffered(agent.runtime),
            ...(agent.runCommands === 'ask' && commandsAsk(agent.runtime)
              ? {
                  askCommand: (entry: { command: string; cwd: string }) =>
                    this.askCommand(
                      agentId,
                      agent.name,
                      entry,
                      signal,
                      context?.unattended === true || task !== undefined,
                    ),
                }
              : {}),
            ...(agent.model ? { model: agent.model } : {}),
          };
          const onEvent = (event: RunEvent) => {
            if (event.type === 'session' && state.session && event.sessionId) {
              state.session.sessionId = event.sessionId;
              state.session.hasRun = true;
            }
            if (event.type === 'plan-usage') this.planUsage = event.usage;
            if (event.type === 'text') assistant.content += event.text;
            if (event.type === 'tool')
              assistant.tools.push({
                name: event.name,
                summary: event.summary,
              });
            this.publish();
          };
          let done = await runTurn(adapter, request, signal, onEvent);
          // Both recovery directions share one retry budget; never chain them.
          if (
            done?.isError &&
            /session id\b[^\n]*\bis already in use\b/i.test(done.text) &&
            !signal.aborted
          ) {
            state.session.hasRun = true;
            await this.persist(state);
            if (signal.aborted) {
              assistant.streaming = false;
              assistant.cancelled = true;
              await this.persist(state);
              return;
            }
            assistant.content = '';
            assistant.tools = [];
            done = await runTurn(
              adapter,
              { ...request, resume: true },
              signal,
              onEvent,
            );
          } else if (
            request.resume &&
            done?.isError &&
            /no conversation found/i.test(done.text) &&
            !signal.aborted
          ) {
            assistant.streaming = false;
            assistant.content = done.text;
            assistant.costUsd = done.costUsd;
            assistant.tokens = totalTokens(done.tokens);
            state.session.costUsd += done.costUsd ?? 0;
            const fallback = state.session.transcriptFallback ?? '';
            await this.persist(state, { closed: true, summary: '' });
            if (signal.aborted) return;
            state.session = this.createSession(state, adapter.id);
            state.session.carrySummary = fallback;
            assistant = {
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
              tools: [],
              streaming: true,
            };
            state.messages = [
              {
                role: 'user',
                content: text,
                timestamp: new Date().toISOString(),
                tools: [],
              },
              assistant,
            ];
            await this.persist(state);
            if (signal.aborted) {
              assistant.streaming = false;
              assistant.cancelled = true;
              await this.persist(state);
              return;
            }
            this.publish();
            done = await runTurn(
              adapter,
              {
                ...request,
                sessionId: state.session.sessionId,
                resume: false,
                prompt: imagePrompt(
                  fallback
                    ? `Previous conversation summary:\n${fallback}\n\nUser message:\n${text}`
                    : text,
                  this.options.managedRoot,
                  this.options.vaultBasePath,
                ),
                previousCostUsd: 0,
              },
              signal,
              onEvent,
            );
          }
          state.session.hasRun ||= !!done && !done.isError;
          if (done && !done.isError) state.session.forkPending = false;
          assistant.streaming = false;
          if (done) {
            assistant.content = done.text;
            assistant.costUsd = done.costUsd;
            assistant.tokens = totalTokens(done.tokens);
            state.session.costUsd += done.costUsd ?? 0;
            if (!done.isError) state.context = done.context;
          } else assistant.cancelled = true;
          if (done && !done.isError && state.agent.id === OBI_ID)
            await this.collectObiProposals(state, done.text);
          if (project && done && !done.isError && !signal.aborted)
            await this.captureMemory(project, done.text, agent.name);
          state.status = done?.isError
            ? done.errorKind === 'auth'
              ? 'needs-you'
              : done.errorKind === 'not-found'
                ? 'offline'
                : 'error'
            : 'idle';
          state.hint = done?.isError
            ? done.errorKind === 'auth'
              ? 'Open a terminal, run the selected runtime once and sign in, then try again.'
              : 'Runtime failed. Check installation and try again.'
            : undefined;
          await this.persist(state);
          outcome = done
            ? done.isError
              ? { status: 'error', reason: done.text || state.hint }
              : { status: 'replied', text: done.text }
            : { status: 'cancelled', reason: 'Run cancelled' };
          if (
            done?.isError &&
            done.errorKind === 'auth' &&
            context &&
            !signal.aborted
          ) {
            await this.orchestrator.addInbox(
              context,
              agentId,
              'runtime-auth',
              state.hint ?? done.text,
              task?.path ?? state.session?.path,
            );
          }
        } catch (error) {
          const unfinished = state.messages.filter(
            (message) => message.streaming,
          );
          for (const message of unfinished) {
            message.streaming = false;
            message.cancelled = true;
          }
          state.status = 'error';
          state.hint = error instanceof Error ? error.message : 'Chat failed';
          if (unfinished.length) await this.persist(state);
          throw error;
        } finally {
          this.publish();
        }
      });
      this.publish();
      return outcome;
    } catch (error) {
      if (workdirRefused && context && !context.stopped && !this.disposed) {
        const state = this.state(agentId);
        if (!task) {
          state.session ??= this.createSession(state);
          state.messages.push({
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
            tools: [],
          });
          state.messages.push({
            role: 'assistant',
            content:
              error instanceof Error ? error.message : 'Working folder refused',
            timestamp: new Date().toISOString(),
            tools: [],
          });
          await this.persist(state);
        }
        await this.orchestrator.addInbox(
          context,
          agentId,
          'workdir-not-allowed',
          error instanceof Error ? error.message : 'Working folder refused',
          task?.path ?? state.session?.path,
        );
      }
      return {
        status:
          !started &&
          error instanceof Error &&
          error.message === 'Queue is stopping'
            ? 'cancelled'
            : failureStatus,
        reason: error instanceof Error ? error.message : 'Chat failed',
        error: error instanceof Error ? error : new Error('Chat failed'),
      };
    } finally {
      m365Run?.stop();
    }
  }

  private async enqueue(
    state: AgentChatSnapshot,
    task: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const id = state.agent.id;
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    if (state.status !== 'working') state.status = 'queued';
    const result = this.queue.enqueue(id, task);
    this.publish();
    try {
      await result;
    } finally {
      const remaining = (this.pending.get(id) ?? 1) - 1;
      this.pending.set(id, remaining);
      if (['working', 'queued', 'idle'].includes(state.status))
        state.status = remaining ? 'queued' : 'idle';
      this.publish();
    }
  }

  async stop(agentId: string): Promise<void> {
    // Stopping an agent stops its loop, and the reviewer turn that loop may be waiting on.
    const loop = this.loops.get(agentId);
    if (loop) {
      loop.stopped = true;
      if (loop.verifierId && loop.verifierId !== agentId)
        await this.stopRuns(loop.verifierId);
    }
    await this.stopRuns(agentId);
  }

  private async stopRuns(agentId: string): Promise<void> {
    this.state(agentId);
    this.agentStopGeneration.set(
      agentId,
      (this.agentStopGeneration.get(agentId) ?? 0) + 1,
    );
    const ids = this.orchestrator.stop(agentId);
    ids.add(agentId);
    await Promise.all([...ids].map((id) => this.queue.cancel(id)));
    this.publish();
  }

  async stopAll(): Promise<void> {
    this.stopGeneration++;
    for (const loop of this.loops.values()) loop.stopped = true;
    this.orchestrator.stop();
    await this.queue.stopAll();
    this.publish();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const pending of [...this.pendingCommands.values()])
      pending.settle(false);
    for (const timer of this.memoryTimers.values()) clearTimeout(timer);
    this.memoryTimers.clear();
    await this.stopAll();
    this.listeners.clear();
  }

  /**
   * Runs a 🔁 loop in this agent's chat. Each round is an ordinary chat turn (same queue, limits and project cost
   * cap); a judging loop asks the reviewer for a verdict on each reply. Only one loop runs per agent.
   */
  async startLoop(
    agentId: string,
    spec: LoopSpec,
    message: string,
    projectId?: string,
  ): Promise<LoopResult> {
    if (this.disposed) throw new Error('Chat service is disposed');
    if (this.loops.has(agentId))
      throw new Error('This agent already has a loop running. Stop it first.');
    if (spec.kind !== 'times' && !this.states[spec.verifierId])
      throw new Error('Pick a reviewer that exists.');
    this.state(agentId);
    const entry = {
      stopped: false,
      verifierId: spec.kind === 'times' ? undefined : spec.verifierId,
      progress: { round: 0, rounds: clampRounds(spec.rounds) },
    };
    this.loops.set(agentId, entry);
    this.publish();
    // One turn of a chat: the reply it produced, or null when the loop was stopped or the turn did not finish.
    const turnOf = async (
      id: string,
      prompt: string,
    ): Promise<LoopTurn | null> => {
      // A round the project cost limit refuses is reported as such, not as an error.
      if (projectId) {
        const refusal = await this.projectLimitRefusal(projectId);
        if (refusal)
          return { text: '', costUsd: 0, failed: false, limit: true };
      }
      const before = this.states[id]?.messages.length ?? 0;
      try {
        await this.send(id, prompt, projectId, true);
      } catch {
        return { text: '', costUsd: 0, failed: true };
      }
      const messages = this.states[id]?.messages ?? [];
      const reply = [...messages].reverse().find((m) => m.role === 'assistant');
      if (
        entry.stopped ||
        messages.length <= before ||
        !reply ||
        reply.cancelled
      )
        return null;
      const status = this.states[id]?.status;
      return {
        text: reply.content,
        costUsd: reply.costUsd ?? 0,
        failed:
          status === 'error' || status === 'offline' || status === 'needs-you',
      };
    };
    let result: LoopResult;
    try {
      result = await runLoop(spec, message, {
        run: (prompt) => turnOf(agentId, prompt),
        judge: (prompt) =>
          entry.verifierId
            ? turnOf(entry.verifierId, prompt)
            : Promise.resolve(null),
        progress: (round, rounds) => {
          entry.progress = { round, rounds };
          this.publish();
        },
        stopped: () => entry.stopped,
      });
    } finally {
      this.loops.delete(agentId);
      this.publish();
    }
    const name = this.states[agentId]?.agent.name ?? agentId;
    await this.orchestrator.logActivity(`${name}: ${loopSummary(result)}`);
    return result;
  }

  /**
   * Runs every schedule that is due at `now`. Called every minute while Obsidian is open. A due run is an ordinary
   * chat turn: it goes through the queue and every cost check, and its status and cost are written to the note.
   * A tick that starts while another is still running does nothing, so a slow tick cannot fire a run twice.
   */
  async tickSchedules(now: Date): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const notes = await this.options.store.loadNotesUnder(
        `${this.options.managedRoot}/Schedules`,
      );
      for (const schedule of loadValidSchedules(notes)) {
        const decision = dueDecision(schedule, now);
        if (decision === 'wait') continue;
        const nextRunAt = followingRun(schedule, now).toISOString();
        if (decision === 'skip-missed') {
          await this.patchSchedule(schedule.path, {
            nextRun: nextRunAt,
            lastStatus: 'missed: skipped',
          });
          continue;
        }
        // The next run is set before this one starts, so a slow run cannot fire the same schedule twice.
        await this.patchSchedule(schedule.path, {
          nextRun: nextRunAt,
          lastRun: now.toISOString(),
          lastStatus: 'running',
        });
        void this.runSchedule(schedule);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Runs one schedule now, once, through the queue. The regular next run is left as it is. */
  async runScheduleNow(path: string): Promise<void> {
    const note = await this.options.store.loadNote(path);
    const schedule = note ? loadValidSchedules([note])[0] : undefined;
    if (!schedule) throw new Error('That schedule could not be read.');
    await this.patchSchedule(path, {
      lastRun: new Date().toISOString(),
      lastStatus: 'running now',
    });
    await this.runSchedule(schedule);
  }

  /** The reason a run is refused by the per-run cap, or null when it may run. */
  private heldByCap(schedule: Schedule): boolean {
    return (
      schedule.costCapUsd !== undefined &&
      (schedule.lastCostUsd ?? 0) >= schedule.costCapUsd
    );
  }

  private async runSchedule(schedule: Schedule): Promise<void> {
    let status = 'done';
    let costUsd = 0;
    if (this.heldByCap(schedule)) {
      // Held: nothing runs until the owner resumes the schedule, which the Inbox item offers.
      await this.patchSchedule(schedule.path, {
        held: true,
        lastStatus: 'held: cost cap reached',
      });
      this.orchestrator.addScheduleHold(
        schedule.agentId,
        `Schedule "${schedule.name}" is held: its last run reached the cost cap of $${schedule.costCapUsd}. Resume it to run again, or raise the cap.`,
        schedule.path,
      );
      return;
    }
    if (!this.states[schedule.agentId]) {
      status = 'skipped: agent not found';
    } else {
      try {
        await this.send(
          schedule.agentId,
          schedule.message,
          schedule.projectId,
          true,
        );
        const messages = this.states[schedule.agentId]?.messages ?? [];
        const reply = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');
        costUsd = reply?.costUsd ?? 0;
        if (!reply || reply.cancelled) status = 'cancelled';
      } catch (error) {
        status = `error: ${error instanceof Error ? error.message : 'run failed'}`;
      }
    }
    await this.patchSchedule(schedule.path, {
      lastStatus: status,
      lastCostUsd: costUsd,
    });
  }

  /** Resumes a held schedule: the owner's choice from the Inbox or the Schedules page. */
  async resumeSchedule(path: string): Promise<void> {
    await resumeScheduleNote(this.options.store, path, new Date());
  }

  /** Writes changed fields to a Schedules note, keeping the rest of the note as it is. */
  private async patchSchedule(
    path: string,
    patch: Partial<ScheduleFields>,
  ): Promise<void> {
    const note = await this.options.store.loadNote(path);
    if (!note) return;
    const merged = {
      ...(note.frontmatter as Record<string, unknown>),
      ...patch,
    };
    const frontmatter = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    );
    await this.options.store.saveNote(path, frontmatter, note.body);
  }

  /** Project memory information for the project form: model in use, note count, last run's context size. */
  async projectMemoryInfo(project: Project): Promise<{
    model: string;
    notes: number;
    lastContextWords: number | null;
  }> {
    const choice = this.memoryChoice(project);
    const resolved = this.resolveMemory(choice);
    const notes = await this.options.store.loadNotesUnder(
      memoryNotesFolder(this.options.managedRoot, project),
    );
    return {
      model:
        choice === 'off'
          ? 'Off (log only)'
          : resolved
            ? `${resolved.adapter.displayName}${resolved.model ? ` (${resolved.model})` : ''}`
            : 'No runtime available',
      notes: notes.length,
      lastContextWords: this.lastContextWords.get(project.id) ?? null,
    };
  }

  /** Runs the memory model over a project's finished tasks now, through the run queue. */
  async extractMemory(projectId: string): Promise<void> {
    const results = this.memoryPending.get(projectId) ?? [];
    this.memoryPending.delete(projectId);
    if (results.length === 0 || this.disposed) return;
    const project = await this.projectById(projectId);
    if (!project || this.memoryChoice(project) === 'off') return;
    await this.queue
      .enqueue(`memory:${projectId}`, async (signal) => {
        try {
          await this.runExtraction(project, results, signal);
        } catch (error) {
          await this.logMemory(
            project,
            `- ${new Date().toISOString()} · memory update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ).catch(() => undefined);
        }
      })
      // A stopped queue skips the extraction; the Log already has the task entries.
      .catch(() => undefined);
  }

  private memoryChoice(project: Project): MemoryChoice {
    return project.memoryModel ?? this.options.settings().memoryModel ?? 'auto';
  }

  private resolveMemory(choice: MemoryChoice) {
    return resolveMemoryRuntime(
      choice,
      this.options.adapters,
      (id) => !!this.runtimes[id]?.available,
    );
  }

  private async projectById(projectId: string): Promise<Project | null> {
    const projects = loadValidProjects(await this.options.store.loadProjects());
    return projects.find((project) => project.id === projectId) ?? null;
  }

  /** Serializes Log and memory writes so concurrent runs cannot lose each other's lines. */
  private serializeMemory<T>(work: () => Promise<T>): Promise<T> {
    const next = this.memoryWrites.then(work);
    this.memoryWrites = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private logMemory(project: Project, lines: string | string[]): Promise<void> {
    const list = Array.isArray(lines) ? lines : [lines];
    return this.serializeMemory(() =>
      appendLogLines(
        this.options.store,
        this.options.managedRoot,
        project,
        list,
      ),
    );
  }

  /** Writes one Log entry for a finished task (no model) and schedules memory extraction. */
  private async taskFinished(
    note: TaskNote,
    worker: Agent,
    request: RequestContext,
  ): Promise<void> {
    if (!request.projectId) return;
    const project = await this.projectById(request.projectId);
    if (!project) return;
    const fm = note.frontmatter;
    const status = String(fm.status);
    const verdict = typeof fm.verdict === 'string' ? fm.verdict : undefined;
    const link = this.options.noteLink
      ? await this.options.noteLink(
          note.path,
          logNotePath(this.options.managedRoot, project),
        )
      : `[[${note.name}]]`;
    await this.logMemory(
      project,
      taskLogEntry({
        time: new Date().toISOString(),
        link,
        agent: worker.name,
        status,
        verdict,
      }),
    );
    const queued = this.memoryPending.get(project.id) ?? [];
    queued.push({
      title: note.name,
      text: [
        `Status: ${status}`,
        verdict ? `Verdict: ${verdict}` : '',
        typeof fm.feedback === 'string' ? `Feedback: ${fm.feedback}` : '',
        note.body,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    });
    this.memoryPending.set(project.id, queued);
    const previous = this.memoryTimers.get(project.id);
    if (previous) clearTimeout(previous);
    this.memoryTimers.set(
      project.id,
      setTimeout(() => {
        this.memoryTimers.delete(project.id);
        void this.extractMemory(project.id);
      }, this.options.memoryDelayMs ?? 3000),
    );
  }

  /** Money already spent on a project: its task runs plus the memory work recorded in its Log. */
  /** Everything spent on a project so far, from the same helper the board uses. */
  private async projectSpend(
    project: Project,
    log: NoteDocument | null,
  ): Promise<number> {
    const tasks = (await this.options.store.loadTasks()).map(taskFacts);
    const chats = (await this.options.store.loadChats()).map(chatFacts);
    return projectSpendUsd(
      project.id,
      tasks,
      chats,
      memoryCostFromLog(logEntries(log)),
    );
  }

  /** A direct project chat is refused once the project's cost limit is reached. */
  /** The reason a project run must not start because the project reached its cost limit; null when it may run. */
  private async projectLimitRefusal(projectId: string): Promise<string | null> {
    const project = await this.projectById(projectId);
    if (!project || project.costLimitUsd === undefined) return null;
    const log = await this.options.store.loadNote(
      logNotePath(this.options.managedRoot, project),
    );
    const spent = await this.projectSpend(project, log);
    if (spent < project.costLimitUsd) return null;
    return `Project cost limit reached: $${spent.toFixed(4)} spent of $${project.costLimitUsd}. Raise the limit in the project form to continue.`;
  }

  /**
   * The planning run for "Reorganise vault": one read-only run through the agent's runtime and model, in a fresh
   * session, in the agent's Work folder, with no vault access, no outside folders, no web, no browser and no
   * whole-computer read. The agent's own chat is not used, so its history is left alone. Returns the reply and its cost.
   */
  async planReply(
    agentId: string,
    prompt: string,
  ): Promise<{ text: string; costUsd: number }> {
    const state = this.state(agentId);
    if (state.status === 'working' || state.status === 'queued')
      throw new Error(
        'This agent is busy. Wait for its reply, then ask for a plan again.',
      );
    const agent = state.agent;
    const adapter = this.options.adapters.find(
      (entry) => entry.id === agent.runtime,
    );
    if (!adapter) throw new Error('This agent’s runtime is not installed.');
    if (!this.runtimes[agent.runtime]?.available)
      await this.detectRuntime(adapter);
    if (!this.runtimes[agent.runtime]?.available)
      throw new Error(
        'This agent’s runtime is not available. Check Setup first.',
      );
    const policy = await resolveWorkdir({
      agentId,
      configDir: this.options.configDir,
      workdir: '',
      vaultAccess: 'off',
      vaultBasePath: this.options.vaultBasePath,
      managedRoot: this.options.managedRoot,
      allowedFolders: [],
      resolvePath: this.options.canonicalPath,
    });
    await this.options.prepareDirectory?.(policy.cwd);
    const request: RunRequest = {
      prompt,
      systemPrompt: '',
      cwd: policy.cwd,
      sessionId: randomUUID(),
      resume: false,
      permission: 'read-only',
      extraDirs: [],
      readDirs: [],
      protectedPaths: policy.protectedPaths,
      webAccess: false,
      canUseBrowser: false,
      browserEngine: this.options.settings().browserEngine ?? 'playwright',
      wholeComputerReadConfirmed: false,
      ...(agent.model ? { model: agent.model } : {}),
    };
    const done = await this.run(
      adapter,
      request,
      new AbortController().signal,
      () => undefined,
    );
    if (!done) throw new Error('The plan run did not finish.');
    if (done.isError) throw new Error(done.text || 'The plan run failed.');
    return { text: done.text, costUsd: done.costUsd ?? 0 };
  }

  /**
   * One model call for the optional graph AI pass, confined like planReply: a fresh session, read-only, in an empty
   * private scratch folder outside the vault, with no vault access, no outside folders, no web, no browser and no
   * commands. The prompt is the only input. Null when no runtime is available; `refused` when the runtime may not run
   * the pass (Codex). The scratch folder is removed afterwards.
   */
  async graphConceptRun(
    prompt: string,
    signal: AbortSignal,
  ): Promise<GraphAiReplyOrRefusal | null> {
    for (const adapter of this.options.adapters)
      if (!this.runtimes[adapter.id]) await this.detectRuntime(adapter);
    const settings = this.options.settings();
    const resolved = this.resolveMemory(settings.memoryModel ?? 'auto');
    if (!resolved) return null;
    const refused = graphAiRefusal(resolved.adapter.id);
    if (refused) return { text: '', costUsd: 0, isError: true, refused };
    const model = settings.graphAiModel || resolved.model;
    const scratch = await mkdtemp(join(tmpdir(), 'agenthq-graph-'));
    try {
      const request: RunRequest = {
        prompt,
        systemPrompt: '',
        cwd: scratch,
        sessionId: randomUUID(),
        resume: false,
        permission: 'read-only',
        extraDirs: [],
        readDirs: [],
        protectedPaths: [],
        webAccess: false,
        canUseBrowser: false,
        browserEngine: settings.browserEngine ?? 'playwright',
        wholeComputerReadConfirmed: false,
        ...(model ? { model } : {}),
      };
      const done = await this.run(
        resolved.adapter,
        request,
        signal,
        () => undefined,
      );
      if (!done) return { text: '', costUsd: 0, isError: true };
      return {
        text: done.text,
        costUsd: done.costUsd ?? 0,
        isError: done.isError,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  /**
   * A one-off question to an agent, like the planning and graph runs: the agent's own runtime and model, read-only,
   * a fresh session, no vault access and no tools needed. Nothing is saved and the agent's conversation is untouched.
   */
  async askOnce(
    agentId: string,
    prompt: string,
    signal: AbortSignal,
    systemPrompt = '',
  ): Promise<{ text: string; costUsd: number; isError: boolean }> {
    const agent = this.state(agentId).agent;
    const adapter = this.options.adapters.find(
      (entry) => entry.id === agent.runtime,
    );
    if (adapter && !this.runtimes[adapter.id])
      await this.detectRuntime(adapter);
    if (!adapter || !this.runtimes[adapter.id]?.available)
      throw new Error(
        `${agent.name}'s runtime is not available. Install and sign in to it, then try again.`,
      );
    // One shared scratch folder in the system temp folder; nothing is written to it and nothing is deleted.
    const scratch = join(tmpdir(), 'agenthq-oneoff');
    await mkdir(scratch, { recursive: true });
    const settings = this.options.settings();
    const request: RunRequest = {
      prompt,
      systemPrompt,
      cwd: scratch,
      sessionId: randomUUID(),
      resume: false,
      permission: 'read-only',
      extraDirs: [],
      readDirs: [],
      protectedPaths: [],
      webAccess: false,
      canUseBrowser: false,
      browserEngine: settings.browserEngine ?? 'playwright',
      wholeComputerReadConfirmed: false,
      ...(agent.model ? { model: agent.model } : {}),
    };
    const done = await this.run(adapter, request, signal, () => undefined);
    if (!done) return { text: '', costUsd: 0, isError: true };
    return {
      text: done.text,
      costUsd: done.costUsd ?? 0,
      isError: done.isError,
    };
  }

  /**
   * A side question to the same agent: a fresh session whose only context is the end of the main conversation. The
   * main conversation, its session and its history are not touched.
   */
  async sideChat(
    agentId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<{ text: string; costUsd: number; isError: boolean }> {
    const state = this.state(agentId);
    const context = this.transcriptOf(
      state.messages.slice(-6),
      state.agent.name,
      SIDE_CONTEXT_CHARS,
    );
    return this.askOnce(
      agentId,
      `${context ? `${context}\n\n` : ''}Side question: ${question}`,
      signal,
      `${state.agent.instructions}\n\nThis is a side conversation: answer the side question briefly. Nothing you say here is added to the main conversation.`,
    );
  }

  private async runExtraction(
    project: Project,
    results: { title: string; text: string }[],
    signal: AbortSignal,
  ): Promise<void> {
    const root = this.options.managedRoot;
    const store = this.options.store;
    for (const adapter of this.options.adapters)
      if (!this.runtimes[adapter.id]) await this.detectRuntime(adapter);
    const now = new Date().toISOString();
    const resolved = this.resolveMemory(this.memoryChoice(project));
    if (!resolved) {
      await this.logMemory(
        project,
        `- ${now} · memory skipped: no runtime available`,
      );
      return;
    }
    const log = await store.loadNote(logNotePath(root, project));
    const spent = await this.projectSpend(project, log);
    if (project.costLimitUsd !== undefined && spent >= project.costLimitUsd) {
      await this.logMemory(
        project,
        `- ${now} · memory skipped: project cost limit reached`,
      );
      return;
    }
    const existing = await store.loadNotesUnder(
      memoryNotesFolder(root, project),
    );
    const request: RunRequest = {
      prompt: extractionPrompt({ project, existing, results }),
      systemPrompt: '',
      cwd: this.options.vaultBasePath,
      sessionId: randomUUID(),
      resume: false,
      permission: 'read-only',
      webAccess: false,
      canUseBrowser: false,
      browserEngine: this.options.settings().browserEngine ?? 'playwright',
      wholeComputerReadConfirmed: false,
      ...(resolved.model ? { model: resolved.model } : {}),
    };
    const done = await this.run(
      resolved.adapter,
      request,
      signal,
      () => undefined,
    );
    if (!done) return;
    const costText = `memory cost $${(done.costUsd ?? 0).toFixed(4)}`;
    if (done.isError) {
      await this.logMemory(
        project,
        `- ${now} · memory update failed · ${costText}`,
      );
      return;
    }
    const { items, problems } = parseMemoryBlocks(done.text);
    const source = `memory model (${resolved.adapter.displayName})`;
    await this.serializeMemory(async () => {
      const saved = await saveMemoryItems(
        store,
        root,
        project,
        items,
        source,
        now,
      );
      await appendLogLines(store, root, project, [
        ...saved.logLines,
        ...problems.map((problem) => `- ${now} · ${problem}`),
        `- ${now} · memory: ${saved.saved} saved, ${saved.merged} merged · ${costText}`,
      ]);
    });
  }

  /** Saves memory blocks an agent put in its reply. No model call. */
  private async captureMemory(
    project: Project,
    text: string,
    agentName: string,
  ): Promise<void> {
    const { items, problems } = parseMemoryBlocks(text);
    if (items.length === 0 && problems.length === 0) return;
    const now = new Date().toISOString();
    try {
      await this.serializeMemory(async () => {
        const saved = await saveMemoryItems(
          this.options.store,
          this.options.managedRoot,
          project,
          items,
          agentName,
          now,
        );
        await appendLogLines(
          this.options.store,
          this.options.managedRoot,
          project,
          [
            ...saved.logLines,
            ...problems.map((problem) => `- ${now} · ${problem}`),
          ],
        );
      });
    } catch (error) {
      await this.logMemory(
        project,
        `- ${now} · memory write failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ).catch(() => undefined);
    }
  }

  /** Retrieved memory and, at the full level, the recent Log, for one agent's run. */
  private async projectMemorySection(
    project: Project,
    agentId: string,
    query: string,
  ): Promise<string> {
    const level = project.contextLevels[agentId] ?? DEFAULT_CONTEXT_LEVEL;
    if (level === 'brief') {
      this.lastContextWords.set(project.id, 0);
      return '';
    }
    const root = this.options.managedRoot;
    const logPath = logNotePath(root, project);
    const memories = await this.options.store.loadNotesUnder(
      memoryNotesFolder(root, project),
    );
    const entries = logEntries(await this.options.store.loadNote(logPath));
    const docs: Snippet[] = [
      ...memories.map((note) => ({
        id: note.path,
        text: `${note.name}\n${note.body}`,
      })),
      ...entries.map((line, index) => ({
        id: `${logPath}#${index}`,
        text: line,
      })),
    ];
    const snippets = rankSnippets(
      query,
      docs,
      RETRIEVAL_CAP_WORDS,
      this.memoryTokens,
    );
    const tail = level === 'full' ? entries.slice(-LOG_TAIL_ENTRIES) : [];
    const text = [
      snippets.length
        ? `## Relevant project memory\n${snippets.map((snippet) => snippet.text).join('\n\n')}`
        : '',
      tail.length
        ? `## Recent project log\n${truncateWords(tail.join('\n'), RETRIEVAL_CAP_WORDS)}`
        : '',
    ]
      .filter((section) => section !== '')
      .join('\n\n');
    this.lastContextWords.set(project.id, wordCount(text));
    return text;
  }

  async newConversation(agentId: string): Promise<void> {
    if (this.disposed) throw new Error('Chat service is disposed');
    if (this.closing.has(agentId))
      throw new Error('New conversation is already in progress');
    const state = this.state(agentId);
    this.closing.add(agentId);
    const generation = this.stopGeneration;
    const agentGeneration = this.agentStopGeneration.get(agentId);
    try {
      await this.queue.cancel(agentId);
      if (
        this.disposed ||
        generation !== this.stopGeneration ||
        agentGeneration !== this.agentStopGeneration.get(agentId)
      )
        return;
      await this.enqueue(state, async (signal) => {
        const agent = state.agent;
        let summary = '';
        try {
          if (
            state.session?.hasRun &&
            state.session.runtimeId === state.agent.runtime
          ) {
            const adapter = this.options.adapters.find(
              (entry) => entry.id === state.agent.runtime,
            );
            if (!adapter || !this.runtimes[state.agent.runtime]?.available)
              throw new Error(
                'Runtime unavailable; the current conversation was kept open',
              );
            const policy = await resolveWorkdir({
              agentId,
              configDir: this.options.configDir,
              workdir: agent.workdir,
              vaultAccess: agent.vaultAccess,
              vaultBasePath: this.options.vaultBasePath,
              managedRoot: this.options.managedRoot,
              allowedFolders: await this.runFolders(
                agent,
                state.session?.projectId,
              ),
              resolvePath: this.options.canonicalPath,
            });
            if (signal.aborted) return;
            await this.options.prepareDirectory?.(policy.cwd);
            if (signal.aborted) return;
            const skills = await this.options.store.loadSkills();
            if (signal.aborted) return;
            const systemPrompt = [
              agent.instructions,
              ...skills
                .filter((skill) => agent.skills.includes(skill.path))
                .map((skill) => `## Skill: ${skill.name}\n${skill.body}`),
            ].join('\n\n');
            state.status = 'working';
            this.publish();
            const done = await this.run(
              adapter,
              {
                ...policy,
                webAccess: agent.webAccess ?? true,
                canUseBrowser: agent.canUseBrowser ?? false,
                browserEngine:
                  this.options.settings().browserEngine ?? 'playwright',
                wholeComputerReadConfirmed:
                  agent.wholeComputerReadConfirmed ?? false,
                browserReadsConfirmed: agent.browserReadsConfirmed ?? false,
                prompt:
                  'Summarize this conversation in exactly 5 lines, retaining important facts and next steps.',
                systemPrompt,
                sessionId: state.session.sessionId,
                ...{ previousCostUsd: state.session.costUsd },
                resume: true,
                permission: state.agent.permission,
                ...(state.agent.model ? { model: state.agent.model } : {}),
              },
              signal,
              () => {
                this.publish();
              },
            );
            if (!done || signal.aborted) return;
            if (!done.isError) {
              summary = done.text;
              state.session.costUsd += done.costUsd ?? 0;
            }
          }
        } catch {
          // Summarization is best-effort; local persistence errors still surface below.
          summary = '';
        }
        if (signal.aborted) return;
        if (state.session) await this.persist(state, { closed: true, summary });
        if (signal.aborted) return;
        state.session = this.createSession(state);
        state.session.carrySummary = summary;
        state.messages = [];
        await this.persist(state);
        state.status = 'idle';
        state.hint = undefined;
      });
    } finally {
      this.closing.delete(agentId);
      this.publish();
    }
  }

  /** The projects, schedules and skills Obi sees and checks its proposals against. */
  private async obiContext(): Promise<{
    projects: Project[];
    schedules: Schedule[];
    skills: Skill[];
  }> {
    const store = this.options.store;
    return {
      projects: loadValidProjects(await store.loadProjects()),
      schedules: loadValidSchedules(
        await store.loadNotesUnder(`${this.options.managedRoot}/Schedules`),
      ),
      skills: await store.loadSkills(),
    };
  }

  private async collectObiProposals(
    state: AgentChatSnapshot,
    reply: string,
  ): Promise<void> {
    const { agents } = await this.options.store.loadAgents();
    const groups = await this.options.store.loadGroups();
    const parsed = parseObiProposals(reply, {
      agents,
      groups,
      ...(await this.obiContext()),
    });
    state.proposals = parsed.proposals;
    state.obiNotes = parsed.problems.length ? parsed.problems : undefined;
    this.publish();
  }

  private pendingCommands = new Map<
    string,
    { agentId: string; settle: (approved: boolean) => void }
  >();

  /** Shows an Approve/Reject card and waits. Nothing is remembered; a stopped run or a closed service rejects. */
  private askCommand(
    agentId: string,
    name: string,
    entry: { command: string; cwd?: string; title?: string },
    signal: AbortSignal,
    unattended: boolean,
  ): Promise<boolean> {
    const visible = this.states[agentId];
    if (!visible || signal.aborted || this.disposed)
      return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const inboxId = unattended
        ? this.orchestrator.addCommandApproval(
            agentId,
            `${name} is waiting for you to approve ${entry.title ? `“${entry.title}”` : 'a command'}.`,
            visible.session?.path,
          )
        : undefined;
      const onAbort = () => settle(false);
      const settle = (approved: boolean) => {
        if (!this.pendingCommands.delete(id)) return;
        signal.removeEventListener('abort', onAbort);
        const left = (visible.commandApprovals ?? []).filter(
          (card) => card.id !== id,
        );
        visible.commandApprovals = left.length ? left : undefined;
        if (inboxId)
          void this.orchestrator
            .resolveInbox(inboxId, 'dismiss')
            .catch(() => {});
        this.publish();
        resolve(approved);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingCommands.set(id, { agentId, settle });
      visible.commandApprovals = [
        ...(visible.commandApprovals ?? []),
        { id, command: entry.command, cwd: entry.cwd, title: entry.title },
      ];
      this.publish();
    });
  }

  /** The owner's answer to a command card. Unknown or already answered cards are ignored. */
  resolveCommand(agentId: string, id: string, approved: boolean): void {
    const pending = this.pendingCommands.get(id);
    if (pending?.agentId === agentId) pending.settle(approved);
  }

  /** Removes a proposal once the owner has approved or rejected it. */
  resolveProposal(agentId: string, proposalId: string): void {
    const state = this.states[agentId];
    if (!state?.proposals) return;
    state.proposals = state.proposals.filter(
      (entry) => entry.id !== proposalId,
    );
    this.publish();
  }

  /** Opens a saved conversation as the agent's active session; the next message resumes it or carries its transcript. */
  async continueChat(agentId: string, path: string): Promise<void> {
    if (this.disposed) throw new Error('Chat service is disposed');
    const state = this.state(agentId);
    if (
      this.closing.has(agentId) ||
      state.status === 'working' ||
      state.status === 'queued'
    )
      throw new Error(
        'Stop or wait for the running reply before continuing a conversation.',
      );
    if (state.session?.path === path) return;
    const note = (await this.chatNotes(agentId)).find(
      (entry) => entry.path === path,
    );
    if (!note) throw new Error('That conversation is no longer available.');
    const fm = record(note.frontmatter);
    if (typeof fm.sessionId !== 'string' || typeof fm.started !== 'string')
      throw new Error('This conversation cannot be continued.');
    if (state.session) await this.persist(state, { closed: true, summary: '' });
    const messages = readMessages(note.body);
    const transcript = this.transcriptOf(messages, state.agent.name);
    if (
      typeof fm.runtimeId === 'string' &&
      fm.runtimeId === state.agent.runtime
    ) {
      state.session = {
        sessionId: fm.sessionId,
        runtimeId: fm.runtimeId,
        path,
        started: fm.started,
        costUsd: typeof fm.costUsd === 'number' ? fm.costUsd : 0,
        hasRun: fm.hasRun !== false,
        title: conversationTitle(note),
        carrySummary: '',
        transcriptFallback: transcript,
        // A fork not yet run must still fork its source, not resume it.
        forkPending: fm.forkPending === true,
      };
    } else {
      // Another runtime cannot resume this session, so start one that carries the transcript.
      state.session = this.createSession(state);
      state.session.path = path;
      state.session.started = fm.started;
      state.session.title = conversationTitle(note);
      state.session.carrySummary = transcript;
    }
    state.messages = messages;
    state.hint = undefined;
    await this.persist(state);
    this.publish();
  }

  /**
   * Forks a conversation at one of its messages: a new chat note for the same agent, with the messages up to and
   * including that one. The original note is not changed. The latest reply forks natively where the runtime can
   * (Claude Code, Codex); everywhere else the new chat starts a fresh session that carries the transcript.
   */
  async forkChat(agentId: string, index: number): Promise<string> {
    if (this.disposed) throw new Error('Chat service is disposed');
    const state = this.state(agentId);
    if (
      this.closing.has(agentId) ||
      state.status === 'working' ||
      state.status === 'queued'
    )
      throw new Error(
        'Stop or wait for the running reply before forking this conversation.',
      );
    const source = state.session;
    if (!source?.path)
      throw new Error('Send a message before forking this conversation.');
    if (!Number.isInteger(index) || index < 0 || index >= state.messages.length)
      throw new Error('That message is no longer available.');
    const messages = state.messages
      .slice(0, index + 1)
      .map((message) => ({ ...message, streaming: false }));
    const latest =
      index === state.messages.length - 1 &&
      messages.at(-1)?.role === 'assistant';
    const native =
      latest &&
      source.hasRun &&
      source.runtimeId === state.agent.runtime &&
      NATIVE_FORK_RUNTIMES.has(source.runtimeId);
    const transcript = this.transcriptOf(messages, state.agent.name);
    state.session = this.createSession(state);
    state.session.title = `Fork of ${source.title ?? 'conversation'}`;
    state.session.projectId = source.projectId;
    state.session.forkedFrom = { path: source.path, index };
    state.session.transcriptFallback = transcript;
    if (native) {
      state.session.sessionId = source.sessionId;
      state.session.hasRun = true;
      state.session.forkPending = true;
      state.session.costUsd = source.costUsd;
    } else {
      state.session.carrySummary = transcript;
    }
    state.messages = messages;
    state.hint = undefined;
    await this.persist(state);
    this.publish();
    return state.session.path;
  }

  /** Changes only the title; the transcript and other frontmatter stay as they are. */
  async renameChat(
    agentId: string,
    path: string,
    title: string,
  ): Promise<void> {
    const clean = title.trim().slice(0, 80);
    if (!clean) throw new Error('Enter a title.');
    const state = this.state(agentId);
    if (
      state.session?.path === path &&
      (this.closing.has(agentId) ||
        state.status === 'working' ||
        state.status === 'queued')
    )
      throw new Error('Stop or wait for the running reply before renaming it.');
    if (state.session?.path === path) {
      state.session.title = clean;
      await this.persist(state);
    } else {
      const note = (await this.chatNotes(agentId)).find(
        (entry) => entry.path === path,
      );
      if (!note) throw new Error('That conversation is no longer available.');
      await this.options.store.saveNote(
        path,
        { ...record(note.frontmatter), title: clean },
        note.body,
      );
      state.history = state.history.map((entry) =>
        entry.path === path
          ? {
              ...entry,
              frontmatter: { ...record(entry.frontmatter), title: clean },
            }
          : entry,
      );
    }
    this.publish();
  }

  /** Earlier messages, most recent kept first within the limit, written oldest first. */
  private transcriptOf(
    messages: ChatEntry[],
    agentName: string,
    limit = 30000,
  ): string {
    const lines: string[] = [];
    let total = 0;
    for (const message of [...messages].reverse()) {
      if (message.streaming || !message.content.trim()) continue;
      const line = `${message.role === 'user' ? 'User' : agentName}: ${message.content}`;
      if (total + line.length > limit) break;
      lines.unshift(line);
      total += line.length;
    }
    return lines.length
      ? `Earlier conversation (most recent messages kept, oldest first):\n${lines.join('\n\n')}`
      : '';
  }

  /** Chat notes for one agent, or for every agent when agentId is null. */
  async chatNotes(agentId: string | null): Promise<NoteDocument[]> {
    return (await this.options.store.loadChats()).filter((note) => {
      const fm = record(note.frontmatter);
      return (
        fm.agenthq === 'chat' && (agentId === null || fm.agentId === agentId)
      );
    });
  }

  /** True while an agent is working or queued on a request in this project. */
  projectBusy(projectId: string): boolean {
    return Object.values(this.states).some(
      (state) =>
        (state.status === 'working' || state.status === 'queued') &&
        state.session?.projectId === projectId,
    );
  }

  /**
   * Trashes chat notes (all of them when paths is omitted) and clears the in-memory
   * conversation, so the next message starts a fresh runtime session. Refuses while an
   * affected agent is busy.
   */
  async deleteChats(agentId: string | null, paths?: string[]): Promise<number> {
    if (this.disposed) throw new Error('Chat service is disposed');
    // Selected notes may belong to several agents; only their owners and the named agent matter.
    const notes = (await this.chatNotes(paths ? null : agentId)).filter(
      (note) => !paths || paths.includes(note.path),
    );
    const owners = notes
      .map((note) => record(note.frontmatter).agentId)
      .filter((id): id is string => typeof id === 'string');
    const affected = paths
      ? [...new Set([...(agentId ? [agentId] : []), ...owners])]
      : agentId === null
        ? Object.keys(this.states)
        : [agentId];
    if (
      affected.some(
        (id) =>
          this.closing.has(id) ||
          this.states[id]?.status === 'working' ||
          this.states[id]?.status === 'queued',
      )
    )
      throw new Error(
        'Stop or wait for a running reply before deleting chat history.',
      );
    for (const note of notes) await this.options.store.trashNote(note.path);
    const removed = new Set(notes.map((note) => note.path));
    for (const id of affected) {
      const state = this.states[id];
      if (!state) continue;
      state.history = state.history.filter((note) => !removed.has(note.path));
      if (state.session && (!paths || paths.includes(state.session.path))) {
        state.session = null;
        state.messages = [];
        state.hint = undefined;
      }
    }
    this.publish();
    return notes.length;
  }

  /**
   * For an agent with vault access: the instruction to read the vault map first, and the vault passages that best
   * match this message, within the retrieval cap. An agent without vault access gets neither.
   */
  /** The note types this agent may write, from Settings → Note destinations. */
  private destinationTypes(agent: Agent): NoteType[] {
    return agentNoteTypes(
      agent,
      this.options.settings().noteTypes ?? [],
      this.options.managedRoot,
      this.options.configDir ?? '',
    );
  }

  /** Where this agent may save notes, the note skill per type, and the notes that already exist there. */
  private async destinationsSection(
    agent: Agent,
    skills: Skill[],
  ): Promise<string> {
    return noteDestinationsSection(
      await Promise.all(
        this.destinationTypes(agent).map(async (type) => ({
          type,
          skill: noteSkillText(type, skills),
          existing: await existingNoteNames(this.options.store, type.folder),
        })),
      ),
      // Agents run in their Work folder, so they need the full path of each destination.
      this.options.vaultBasePath,
    );
  }

  /** The agents working right now that may write a note in this path's destination, for the Activity line. */
  writersFor(path: string): string[] {
    const types = (this.options.settings().noteTypes ?? []).filter(
      (type) =>
        type.enabled &&
        path.startsWith(`${type.folder.trim().replace(/\/+$/, '')}/`),
    );
    return Object.values(this.states)
      .filter(
        (state) =>
          state.status === 'working' &&
          types.some((type) => state.agent.noteTypes?.includes(type.id)),
      )
      .map((state) => state.agent.name);
  }

  /** Passages from this agent's own earlier chats, when the message looks back at them. */
  private async recallSection(
    agent: Agent,
    message: string,
    currentPath: string | undefined,
  ): Promise<string> {
    if (!isRecallRequest(message)) return '';
    return chatRecallSection(
      message,
      await this.options.store.loadChats(),
      agent.id,
      currentPath,
      this.recallTokens,
    );
  }

  private async vaultSection(agent: Agent, message: string): Promise<string> {
    if (!hasVaultAccess(agent)) return '';
    const passages = this.options.vaultSnippets
      ? await this.options.vaultSnippets()
      : [];
    return [
      vaultMapInstruction(this.options.managedRoot),
      vaultSearchSection(
        message,
        passages,
        RETRIEVAL_CAP_WORDS,
        this.passageTokens,
      ),
    ]
      .filter((part) => part !== '')
      .join('\n\n');
  }

  /**
   * The folders a run may use outside Work: the agent's own ticked folders, plus the Output folder of the project it
   * runs for when the agent is assigned to that project. Without a list (agents made before this version) all of
   * Settings' folders apply, so an upgrade changes nothing.
   */
  private async runFolders(
    agent: Agent,
    projectId: string | undefined,
  ): Promise<string[]> {
    const allowed = [
      ...agentOutsideFolders(agent, this.options.settings().allowedFolders),
      // Note destinations the owner ticked for this agent: only those folders, nothing else in the vault.
      ...destinationFolders(this.destinationTypes(agent)),
    ];
    const project = await this.projectFor(projectId);
    const output = project?.outputFolder?.trim() ?? '';
    if (
      !project ||
      output === '' ||
      outputFolderProblem(
        output,
        this.options.managedRoot,
        // The host always passes its configDir, so the configuration folder is protected in the plugin.
        this.options.configDir ?? '',
      ) !== undefined
    )
      return allowed;
    const { agents } = await this.options.store.loadAgents();
    const groups = await this.options.store.loadGroups();
    if (!assignedAgentIds(project, agents, groups).has(agent.id))
      return allowed;
    return [...allowed, output];
  }

  /** The project a run belongs to, if its note still exists and is valid. */
  private async projectFor(id: string | undefined): Promise<Project | null> {
    if (!id) return null;
    for (const note of await this.options.store.loadProjects()) {
      const parsed = parseProject(note);
      if (!('problem' in parsed) && parsed.id === id) return parsed;
    }
    return null;
  }

  private async run(
    adapter: RuntimeAdapter,
    request: RunRequest,
    signal: AbortSignal,
    onEvent: (event: RunEvent) => void,
  ): Promise<Extract<RunEvent, { type: 'done' }> | null> {
    if (signal.aborted) return null;
    let complete!: (event: Extract<RunEvent, { type: 'done' }> | null) => void;
    const result = new Promise<Extract<RunEvent, { type: 'done' }> | null>(
      (resolve) => {
        complete = resolve;
      },
    );
    let finished = false;
    const handle = adapter.start(request, (event) => {
      if (signal.aborted || finished) return;
      if (event.type === 'done') {
        finished = true;
        complete(event);
      } else onEvent(event);
    });
    const abort = () => {
      finished = true;
      complete(null);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await result;
    } finally {
      signal.removeEventListener('abort', abort);
      await handle.stop();
    }
  }

  private async persist(
    state: AgentChatSnapshot,
    closure?: { closed: true; summary: string },
  ): Promise<void> {
    const session = state.session!;
    const taskState = this.taskNotes.get(state);
    if (taskState) {
      const { note: task, verification } = taskState;
      const field = (name: string) =>
        verification
          ? 'verifier' + name[0]!.toUpperCase() + name.slice(1)
          : name;
      Object.assign(task.frontmatter, {
        [field('sessionId')]: session.sessionId,
        [field('runtimeId')]: session.runtimeId,
        [field('hasRun')]: session.hasRun,
        [field('costUsd')]: session.costUsd,
      });
      const persisted = this.taskPersisted.get(state) ?? new Set<ChatEntry>();
      for (const message of state.messages) {
        if (
          message.role !== 'assistant' ||
          message.streaming ||
          persisted.has(message)
        )
          continue;
        task.body += `\n\n${verification ? '### Verifier' : '## Attempt'} ${String(task.frontmatter.attempt)}\n\n${message.content}${message.cancelled ? '\n\nCancelled' : ''}`;
        persisted.add(message);
      }
      this.taskPersisted.set(state, persisted);
      await this.orchestrator.saveTask(task);
      return;
    }
    const folder = `${this.options.managedRoot}/Chats`;
    if (!(await this.options.store.exists(folder))) {
      try {
        await this.options.store.createFolder(folder);
      } catch (error) {
        // Concurrent agents may have created the shared chat folder meanwhile.
        if (!(await this.options.store.exists(folder))) throw error;
      }
    }
    const firstMessage = state.messages.find(
      (message) => message.role === 'user',
    );
    if (session.title === undefined && firstMessage)
      session.title = chatTitle(firstMessage.content);
    if (!session.path || (session.titlePending && firstMessage)) {
      const oldPath = session.path;
      const base = `${folder}/${chatBasename(session.started, state.agent.name, session.title ?? '')}`;
      let path = `${base}.md`;
      for (
        let suffix = 2;
        path !== oldPath && (await this.options.store.exists(path));
        suffix++
      )
        path = `${base} (${suffix}).md`;
      if (oldPath && path !== oldPath) {
        await this.options.store.renameNote(oldPath, path);
        state.history = state.history.filter((note) => note.path !== oldPath);
      }
      session.path = path;
      session.titlePending = !firstMessage;
    }
    const agent = this.options.agentLink
      ? await this.options.agentLink(state.agent.path, session.path)
      : `[[${state.agent.path.replace(/\.md$/, '')}]]`;
    let body = state.messages
      .filter((message) => !message.streaming)
      .map((message) => {
        const tools = message.tools.length
          ? `\n\n> [!tools]-\n${message.tools.map((tool) => `> ${tool.name}: ${tool.summary.replace(/\n/g, '\n> ')}`).join('\n')}`
          : '';
        const metadata = JSON.stringify({
          role: message.role,
          timestamp: message.timestamp,
          tools: message.tools,
          costUsd: message.costUsd,
          tokens: message.tokens,
          cancelled: message.cancelled,
          contentLength: message.content.length,
          tailLength: tools.length,
        })
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e');
        return `<!-- agenthq-message ${metadata} -->\n### ${message.role === 'user' ? 'You' : state.agent.name} · ${localTime(message.timestamp)}\n\n${message.content}${tools}`;
      })
      .join('\n\n');
    if (closure) body += `\n\n## Summary\n\n${closure.summary}`;
    const { path: _path, transcriptFallback: _fallback, ...metadata } = session;
    const frontmatter = {
      agenthq: 'chat',
      agent,
      agentId: state.agent.id,
      ...metadata,
      ...closure,
    };
    await this.options.store.saveNote(session.path, frontmatter, body);
    const note = {
      path: session.path,
      name: session.path.split('/').pop()!.replace(/\.md$/, ''),
      frontmatter,
      body,
    };
    state.history = [
      ...state.history.filter((entry) => entry.path !== session.path),
      note,
    ];
  }
}
