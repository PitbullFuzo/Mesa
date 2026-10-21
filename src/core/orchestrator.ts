import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taskSchema, type Agent } from './model';
import type { NoteDocument } from './notes';
import type { Store } from './store';
import { parseDelegation, parseVerdict, type DelegatedTask } from './protocol';
import { changedFiles, taskProblem, type TurnTool } from './taskOutcome';

export interface OrchestrationTurn {
  status: string;
  text?: string;
  reason?: string;
  error?: Error;
  /** Tool events of this turn, used to see which files a task changed. */
  tools?: TurnTool[];
}
export interface TaskNote extends NoteDocument {
  frontmatter: Record<string, unknown>;
}
export const inboxItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  kind: z.enum([
    'invalid-delegation',
    'depth-limit',
    'run-limit',
    'verification-exhausted',
    'runtime-auth',
    'workdir-not-allowed',
    'schedule-held',
    'command-approval',
    'task-incomplete',
  ]),
  message: z.string(),
  created: z.string(),
  path: z.string().optional(),
  resolved: z.boolean().optional(),
  resolution: z.enum(['accept', 'retry', 'cancel', 'dismiss']).optional(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;
export interface RequestBudget {
  id: string;
  runs: number;
  requests: Set<RequestContext>;
  limitHit?: boolean;
}
export interface RequestContext {
  id: string;
  agents: Set<string>;
  stopped: boolean;
  budget: RequestBudget;
  controller: AbortController;
  limitHit?: boolean;
  /** The project this request runs in; inherited by delegated tasks and their verifiers. */
  projectId?: string;
  /** A schedule or loop run: nobody is watching the chat, so a command approval also goes to the Inbox. */
  unattended?: boolean;
}
export interface OrchestratorOptions {
  store: Store;
  managedRoot: string;
  agents: () => Agent[];
  settings: () => {
    maxDelegationDepth?: number;
    maxRunsPerRequest?: number;
    defaultVerifierAttempts?: number;
  };
  turn: (
    agentId: string,
    text: string,
    request: RequestContext,
    task?: TaskNote,
    verification?: boolean,
  ) => Promise<OrchestrationTurn>;
  changed: () => void;
  loadInbox?: () => Promise<unknown>;
  saveInbox?: (items: InboxItem[]) => Promise<void>;
  needsYou: (agentId: string, reason: string) => void;
  chatPath: (agentId: string) => string | undefined;
  noteLink?: (path: string, sourcePath: string) => Promise<string>;
  /** Called once a delegated task is saved in its final state. */
  taskFinished?: (
    note: TaskNote,
    worker: Agent,
    request: RequestContext,
  ) => Promise<void>;
}

/** Coordinates turns outside queue slots; every inference is supplied by ChatService.sendTurn. */
export class Orchestrator {
  tasks: TaskNote[] = [];
  inbox: InboxItem[] = [];
  private readonly requests = new Set<RequestContext>();
  private writes: Promise<void> = Promise.resolve();
  private inboxWrites: Promise<void> = Promise.resolve();
  private readonly resolving = new Set<string>();
  constructor(private readonly options: OrchestratorOptions) {}

  async initialize(): Promise<void> {
    this.tasks = (await this.options.store.loadTasks()).filter(
      (note): note is TaskNote =>
        taskSchema.safeParse(note.frontmatter).success,
    );
    const saved = await this.options.loadInbox?.();
    this.inbox = Array.isArray(saved)
      ? saved.flatMap((item: unknown) => {
          const parsed = inboxItemSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  }

  createBudget(): RequestBudget {
    return { id: randomUUID(), runs: 0, requests: new Set() };
  }

  async request(
    agentId: string,
    text: string,
    budget = this.createBudget(),
    projectId?: string,
    unattended = false,
  ): Promise<OrchestrationTurn> {
    const request: RequestContext = {
      id: budget.id,
      agents: new Set([agentId]),
      stopped: budget.limitHit ?? false,
      budget,
      controller: new AbortController(),
      projectId,
      unattended,
    };
    this.requests.add(request);
    budget.requests.add(request);
    try {
      return await this.execute(agentId, text, request, 0);
    } finally {
      this.requests.delete(request);
      budget.requests.delete(request);
    }
  }

  private async execute(
    agentId: string,
    text: string,
    request: RequestContext,
    depth: number,
    task?: TaskNote,
  ): Promise<OrchestrationTurn> {
    if (request.stopped)
      return { status: 'cancelled', reason: 'Request stopped' };
    request.agents.add(agentId);
    let result = await this.options.turn(agentId, text, request, task);
    if (request.stopped)
      return { status: 'cancelled', reason: 'Request stopped' };
    if (result.status !== 'replied') return result;
    let parsed = parseDelegation(result.text ?? '');
    const invalidReason = () => {
      if (parsed.kind === 'invalid') return parsed.reason;
      if (
        parsed.kind === 'valid' &&
        parsed.tasks.some(
          (spec) =>
            spec.verifyWith &&
            this.options
              .agents()
              .filter((agent) => agent.name === spec.verifyWith).length !== 1,
        )
      )
        return 'Verifier must be an existing agent, using its exact name.';
      if (
        parsed.kind === 'valid' &&
        parsed.tasks.some(
          (spec) =>
            this.options
              .agents()
              .filter(
                (agent) =>
                  agent.name === spec.to && agent.reportsTo === agentId,
              ).length !== 1,
        )
      )
        return 'Only delegate to your direct reports, using their exact names.';
      return undefined;
    };
    let reason = invalidReason();
    if (reason) {
      result = await this.options.turn(
        agentId,
        `Correction: ${reason}\nReturn a corrected agenthq-delegate block, or answer normally without delegation.`,
        request,
        task,
      );
      if (request.stopped)
        return { status: 'cancelled', reason: 'Request stopped' };
      if (result.status !== 'replied') return result;
      parsed = parseDelegation(result.text ?? '');
      reason = invalidReason();
      if (reason) {
        await this.addInbox(
          request,
          agentId,
          'invalid-delegation',
          reason,
          task?.path,
        );
        return { status: 'error', reason, text: result.text };
      }
    }
    if (parsed.kind !== 'valid') return result;
    if (depth >= (this.options.settings().maxDelegationDepth ?? 3)) {
      await this.limit(
        request,
        agentId,
        'depth-limit',
        'Maximum delegation depth reached',
        task?.path,
      );
      return {
        status: 'cancelled',
        reason: 'Maximum delegation depth reached',
      };
    }
    const agents = this.options.agents();
    const lead = agents.find((agent) => agent.id === agentId)!;
    const notes: { note: TaskNote; worker: Agent }[] = [];
    for (const spec of parsed.tasks) {
      if (request.stopped) break;
      const worker = agents.find(
        (agent) => agent.name === spec.to && agent.reportsTo === agentId,
      );
      if (!worker) continue;
      const note = await this.createTask(
        lead,
        worker,
        spec,
        request,
        depth + 1,
      );
      notes.push({ note, worker });
    }
    await Promise.all(
      notes.map(async ({ note, worker }) => {
        await this.runTask(note, worker, request);
        await this.saveTask(note);
        await this.options.taskFinished?.(note, worker, request);
        await this.activity(
          async (source) =>
            `${await this.link(worker.path, source)} completed ${await this.link(note.path, source)} (${String(note.frontmatter.status)})`,
        );
      }),
    );
    if (request.stopped)
      return { status: 'cancelled', reason: 'Request stopped' };
    result = await this.execute(
      agentId,
      `Results from your team:\n\n${(await Promise.all(notes.map(async ({ note }) => `${await this.link(note.path, task?.path ?? this.options.chatPath(agentId))} — ${String(note.frontmatter.status)}\n${note.body}`))).join('\n\n')}`,
      request,
      depth,
      task,
    );
    return result;
  }

  private async runTask(
    note: TaskNote,
    worker: Agent,
    request: RequestContext,
  ): Promise<void> {
    const fm = note.frontmatter;
    let prompt =
      Number(fm.attempt) > 0
        ? `Verifier feedback:
${typeof fm.feedback === 'string' ? fm.feedback : 'Please try again.'}

Resume the task and address this feedback.`
        : String(fm.taskText);
    while (!request.stopped) {
      if (Number(fm.attempt) > 0) fm.attempt = Number(fm.attempt) + 1;
      const answer = await this.execute(
        worker.id,
        prompt,
        request,
        Number(fm.depth),
        note,
      );
      if (request.stopped || answer.status !== 'replied') {
        fm.status = request.stopped
          ? request.limitHit
            ? 'needs-you'
            : 'cancelled'
          : answer.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
        if (fm.status === 'failed' && answer.reason)
          note.body += `\n\n### Failed\n\n${answer.reason}`;
        break;
      }
      const problem = taskProblem(
        String(fm.taskText),
        answer.text ?? '',
        answer.tools ?? [],
      );
      if (!fm.verifierId) {
        if (problem) {
          await this.incomplete(note, worker, request, problem.message);
          return;
        }
        fm.status = 'passed';
        break;
      }
      fm.status = 'verifying';
      await this.saveTask(note);
      const verifierId = typeof fm.verifierId === 'string' ? fm.verifierId : '';
      request.agents.add(verifierId);
      const checked = await this.options.turn(
        verifierId,
        `Verify task:
${String(fm.taskText)}

Worker answer:
${answer.text ?? ''}

Files the worker actually changed: ${changedFiles(answer.tools ?? []).join(', ') || 'none'}
If the task asked for something to be written and no file was changed, the verdict must be fail.

Working folder: ${String(fm.workerWorkdir)}
Attempt: ${String(fm.attempt)}
End with exactly one terminal agenthq-verdict JSON block containing verdict (pass or fail) and feedback.`,
        request,
        note,
        true,
      );
      if (request.stopped || checked.status === 'cancelled') {
        fm.status = request.limitHit ? 'needs-you' : 'cancelled';
        break;
      }
      const verdict = parseVerdict(checked.text ?? '');
      fm.verdict = verdict.verdict;
      fm.feedback = verdict.feedback;
      note.body += `

### Verification ${String(fm.attempt)} — ${verdict.verdict}

${verdict.feedback}`;
      if (checked.status !== 'replied') {
        fm.status = 'failed';
        break;
      }
      if (verdict.verdict === 'pass') {
        if (problem) {
          await this.incomplete(note, worker, request, problem.message);
          return;
        }
        fm.status = 'passed';
        break;
      }
      if (Number(fm.attempt) >= Number(fm.maxAttempts)) {
        fm.status = 'needs-you';
        await this.saveTask(note);
        await this.addInbox(
          request,
          worker.id,
          'verification-exhausted',
          verdict.feedback,
          note.path,
        );
        return;
      }
      prompt = `Verifier feedback:
${verdict.feedback}

Resume the task and address this feedback.`;
    }
    if (request.stopped)
      fm.status = request.limitHit ? 'needs-you' : 'cancelled';
    await this.saveTask(note);
  }

  /** The worker answered but did not do the work: "needs you" with the reason, never "passed". */
  private async incomplete(
    note: TaskNote,
    worker: Agent,
    request: RequestContext,
    message: string,
  ): Promise<void> {
    note.frontmatter.status = 'needs-you';
    note.body += `

### Needs you

${message}`;
    await this.saveTask(note);
    await this.addInbox(
      request,
      worker.id,
      'task-incomplete',
      message,
      note.path,
    );
  }

  private async createTask(
    lead: Agent,
    worker: Agent,
    spec: DelegatedTask,
    request: RequestContext,
    depth: number,
  ): Promise<TaskNote> {
    const title =
      spec.task
        .replace(/[<>:"/\\|?*#^[\]]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 70) || 'Task';
    const date = new Date().toISOString();
    const folder = `${this.options.managedRoot}/Tasks`;
    await this.folder(folder);
    const path = `${folder}/${date.slice(0, 10)} ${date.slice(11, 16).replace(':', '')} ${title} - ${randomUUID().slice(0, 8)}.md`;
    const verifier = spec.verifyWith
      ? this.options.agents().find((agent) => agent.name === spec.verifyWith)
      : this.options.agents().find((agent) => agent.id === worker.verifier);
    const note: TaskNote = {
      path,
      name: path.split('/').at(-1)!.replace(/\.md$/, ''),
      frontmatter: {
        agenthq: 'task',
        from: await this.link(lead.path, path),
        to: await this.link(worker.path, path),
        fromId: lead.id,
        toId: worker.id,
        verifier: verifier ? await this.link(verifier.path, path) : null,
        verifierId: verifier?.id,
        projectId: request.projectId ?? null,
        workerWorkdir:
          worker.workdir || `${this.options.managedRoot}/Work/${worker.id}`,
        status: 'queued',
        attempt: 0,
        maxAttempts:
          spec.maxAttempts ??
          this.options.settings().defaultVerifierAttempts ??
          3,
        requestId: request.id,
        depth,
        sessionId: randomUUID(),
        taskText: spec.task,
      },
      body: spec.task,
    };
    await this.options.store.createNote(path, note.frontmatter, note.body);
    this.tasks.push(note);
    this.options.changed();
    await this.activity(
      async (source) =>
        `${await this.link(lead.path, source)} delegated ${await this.link(path, source)} to ${await this.link(worker.path, source)}`,
    );
    return note;
  }

  async saveTask(note: TaskNote): Promise<void> {
    await this.options.store.saveNote(note.path, note.frontmatter, note.body);
    this.options.changed();
  }

  stop(agentId?: string): Set<string> {
    const ids = new Set<string>();
    for (const request of this.requests) {
      if (agentId !== undefined && !request.agents.has(agentId)) continue;
      request.stopped = true;
      request.controller.abort();
      for (const id of request.agents) ids.add(id);
    }
    return ids;
  }

  async beforeRun(
    request: RequestContext,
    agentId: string,
    path?: string,
  ): Promise<boolean> {
    if (request.stopped) return false;
    if (
      request.budget.runs >= (this.options.settings().maxRunsPerRequest ?? 25)
    ) {
      await this.limit(
        request,
        agentId,
        'run-limit',
        'Maximum runs per request reached',
        path,
      );
      return false;
    }
    request.budget.runs++;
    return true;
  }

  private async limit(
    request: RequestContext,
    agentId: string,
    kind: InboxItem['kind'],
    message: string,
    path?: string,
  ): Promise<void> {
    if (request.stopped) return;
    request.budget.limitHit = true;
    for (const member of request.budget.requests) {
      member.stopped = true;
      member.limitHit = true;
      member.controller.abort();
    }
    await this.addInbox(request, agentId, kind, message, path);
  }

  async addInbox(
    request: RequestContext,
    agentId: string,
    kind: InboxItem['kind'],
    message: string,
    path?: string,
  ): Promise<void> {
    this.inbox.push({
      id: randomUUID(),
      requestId: request.id,
      agentId,
      kind,
      message,
      created: new Date().toISOString(),
      path: path ?? this.options.chatPath(agentId),
    });
    await this.persistInbox();
    this.options.needsYou(agentId, message);
    this.options.changed();
  }

  /** A schedule was held by its cost cap: one Inbox item, resumed from the Inbox. */
  addScheduleHold(agentId: string, message: string, path: string): void {
    this.inbox.push({
      id: randomUUID(),
      requestId: `schedule:${path}`,
      agentId,
      kind: 'schedule-held',
      message,
      created: new Date().toISOString(),
      path,
    });
    void this.persistInbox();
    this.options.needsYou(agentId, message);
    this.options.changed();
  }

  /** An unattended run is waiting for the owner to approve a command: one Inbox item, cleared when answered. */
  addCommandApproval(agentId: string, message: string, path?: string): string {
    const id = randomUUID();
    this.inbox.push({
      id,
      requestId: `command:${id}`,
      agentId,
      kind: 'command-approval',
      message,
      created: new Date().toISOString(),
      path: path ?? this.options.chatPath(agentId),
    });
    void this.persistInbox();
    this.options.needsYou(agentId, message);
    this.options.changed();
    return id;
  }

  private async persistInbox(): Promise<void> {
    const write = this.inboxWrites.then(async () => {
      await this.options.saveInbox?.(structuredClone(this.inbox));
    });
    this.inboxWrites = write.catch(() => {});
    await write;
  }

  async resolveInbox(
    id: string,
    action: 'accept' | 'retry' | 'cancel' | 'dismiss',
  ): Promise<void> {
    const item = this.inbox.find((entry) => entry.id === id);
    if (!item) throw new Error('Inbox item not found');
    if (item.resolved || this.resolving.has(id)) return;
    if (action !== 'dismiss' && item.kind !== 'verification-exhausted')
      throw new Error('This inbox item can only be dismissed');
    const note = this.tasks.find((task) => task.path === item.path);
    if (action !== 'dismiss' && !note) throw new Error('Task note not found');
    const worker = this.options
      .agents()
      .find((agent) => agent.id === note?.frontmatter.toId);
    if (action === 'retry' && !worker)
      throw new Error('Worker no longer exists');
    this.resolving.add(id);
    const budget = this.createBudget();
    const request: RequestContext = {
      id: budget.id,
      agents: new Set([item.agentId]),
      stopped: false,
      budget,
      controller: new AbortController(),
    };
    this.requests.add(request);
    budget.requests.add(request);
    try {
      if (note && action !== 'dismiss') {
        if (action === 'retry') {
          if (note.frontmatter.inboxResolutionId !== id)
            note.frontmatter.maxAttempts =
              Number(note.frontmatter.maxAttempts) + 2;
          note.frontmatter.status = 'queued';
        } else {
          note.frontmatter.status =
            action === 'accept' ? 'passed' : 'cancelled';
          if (action === 'accept') note.frontmatter.verdict = 'Accepted anyway';
        }
        note.frontmatter.inboxResolutionId = id;
        note.body += `\n\n### Inbox resolution\n\n${action}`;
        await this.saveTask(note);
      }
      item.resolved = true;
      item.resolution = action;
      try {
        await this.persistInbox();
      } catch (error) {
        item.resolved = false;
        delete item.resolution;
        throw error;
      }
      this.options.changed();
      if (action === 'retry' && note && worker) {
        await this.runTask(note, worker, request);
        await this.activity(
          async (source) =>
            `${await this.link(worker.path, source)} completed ${await this.link(note.path, source)} (${String(note.frontmatter.status)})`,
        );
        if (!request.stopped) {
          const parent = this.tasks.find(
            (entry) =>
              entry.frontmatter.requestId === note.frontmatter.requestId &&
              entry.frontmatter.toId === note.frontmatter.fromId &&
              Number(entry.frontmatter.depth) ===
                Number(note.frontmatter.depth) - 1,
          );
          await this.execute(
            String(note.frontmatter.fromId),
            `Results from your team:\n\n${await this.link(note.path, parent?.path ?? this.options.chatPath(String(note.frontmatter.fromId)))} — ${String(note.frontmatter.status)}\n${note.body}`,
            request,
            Number(note.frontmatter.depth) - 1,
            parent,
          );
        }
      }
    } finally {
      this.requests.delete(request);
      budget.requests.delete(request);
      this.resolving.delete(id);
      this.options.changed();
    }
  }

  private async link(
    path: string,
    source = `${this.options.managedRoot}/Chats`,
  ): Promise<string> {
    return this.options.noteLink
      ? this.options.noteLink(path, source)
      : `[[${path.replace(/\.md$/, '')}]]`;
  }
  private async folder(path: string): Promise<void> {
    if (!(await this.options.store.exists(path))) {
      try {
        await this.options.store.createFolder(path);
      } catch (error) {
        if (!(await this.options.store.exists(path))) throw error;
      }
    }
  }
  /** Writes one line to this month's Activity note. */
  logActivity(text: string): Promise<void> {
    return this.activity(async () => text);
  }

  private async activity(
    message: (source: string) => Promise<string>,
  ): Promise<void> {
    const timestamp = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const month = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}`;
    const time = `${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}`;
    const write = this.writes.then(async () => {
      const folder = `${this.options.managedRoot}/Activity`;
      await this.folder(folder);
      const path = `${folder}/${month}.md`;
      const line = `- ${time} ${await message(path)}`;
      const existing = (await this.options.store.loadActivity()).find(
        (note) => note.path === path,
      );
      await this.options.store.saveNote(
        path,
        (existing?.frontmatter as Record<string, unknown> | undefined) ?? {
          agenthq: 'activity',
        },
        `${existing?.body ? existing.body.trimEnd() + '\n' : ''}${line}\n`,
      );
    });
    this.writes = write.catch(() => {});
    await write;
  }
}
