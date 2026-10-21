/* eslint obsidianmd/prefer-window-timers: off -- Node subprocess protocol has no browser window. */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserUnavailableReason } from '../browser';
import {
  M365_SERVER,
  m365ServerCommand,
  m365UnavailableReason,
} from '../m365/launch';
import { browserLaunchFor, browserServerCommand } from './browserTools';
import { killProcessTree } from './processTree';
import { approveAcpEdit, canonicalFile, record } from './acpPolicy';
import type { Executable } from './detect';
import type {
  RuntimeAdapter,
  RuntimeId,
  RunEvent,
  RunRequest,
  RuntimeStatus,
} from './types';
const stringValue = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;
interface AcpOptions {
  id: RuntimeId;
  displayName: string;
  resolve: () => Promise<Executable | undefined>;
  policy?: string;
  agentInfo?: { name: string; version: string };
  mode?: string;
  missingHint?: string;
  prepareEnv?: (request: RunRequest) => Promise<NodeJS.ProcessEnv>;
  approvePermission?: (
    request: RunRequest,
    call: unknown,
    known: unknown,
    canonical: (path: string) => Promise<string>,
  ) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  /** Where Mesa's browser helper is installed; browser runs are refused without it. */
  browserHelper?: string;
  /**
   * Set for runtimes that take the browser server in ACP `session/new` (Hermes): the value the shim must report
   * at initialize. Without it the server reaches the runtime through its environment (OpenCode).
   */
  browserPolicy?: string;
}
interface AcpDeps {
  spawn: (
    file: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  killTree: (pid: number) => Promise<void>;
  canonical: (path: string) => Promise<string>;
}
/** Newline JSON-RPC ACP transport. Runtime-specific bootstrap/detection stays outside. */
export class AcpRuntime implements RuntimeAdapter {
  readonly id: RuntimeId;
  readonly displayName: string;
  private executable?: Executable;
  private pids = new Set<number>();
  private deps: AcpDeps;
  constructor(
    private options: AcpOptions,
    deps: Partial<AcpDeps> = {},
  ) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.deps = {
      spawn,
      killTree: killProcessTree,
      canonical: canonicalFile,
      ...deps,
    };
  }
  get activePids(): readonly number[] {
    return [...this.pids];
  }
  async detect(): Promise<RuntimeStatus> {
    try {
      this.executable = await this.options.resolve();
      return this.executable
        ? {
            available: true,
            path: this.executable.path,
            version: this.executable.version,
          }
        : {
            available: false,
            hint:
              this.options.missingHint ??
              'Install Hermes with ACP support and configure a provider in Hermes. No safe runtime was found.',
          };
    } catch {
      return {
        available: false,
        hint:
          this.options.missingHint ??
          'Hermes ACP policy check failed. Update Hermes/ACP or check its provider configuration.',
      };
    }
  }
  start(input: RunRequest, onEvent: (event: RunEvent) => void) {
    const request: RunRequest = { ...input };
    let browserDir: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined,
      stopped = false,
      closed = false,
      finished = false,
      session = '',
      active = false,
      text = '',
      stderr = '';
    let next = 0;
    const tools = new Map<string, Record<string, unknown>>();
    let sessionCost: number | undefined;
    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>((r) => {
      resolveClosed = r;
    });
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const failPending = (error: Error) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
    };
    const send = (value: unknown) => {
      if (!child || closed) throw Error('ACP process is closed.');
      child.stdin.write(JSON.stringify(value) + '\n');
    };
    const rpc = (method: string, params: unknown, timeout = 60000) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`ACP ${method} timed out.`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : Error('ACP write failed'));
        }
      });
    let teardown: Promise<void> | undefined;
    const cleanup = () =>
      (teardown ??= (async () => {
        failPending(Error('ACP run ended.'));
        if (child?.pid && !closed) {
          try {
            await this.deps.killTree(child.pid);
          } catch (error) {
            // Windows taskkill can report already-exiting descendants, sometimes just before the close
            // event arrives. A transport that is still alive after a short wait makes cleanup fail.
            if (!closed) {
              const exited = await Promise.race([
                closedPromise.then(() => true),
                new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
              ]);
              if (!exited) throw error;
            }
          }
          await closedPromise;
        }
        if (browserDir) rmSync(browserDir, { recursive: true, force: true });
      })().catch((error) => {
        teardown = undefined;
        throw error;
      }));
    let finishing: Promise<void> | undefined;
    const finish = (event: Extract<RunEvent, { type: 'done' }>) =>
      (finishing ??= (async () => {
        await cleanup();
        if (!finished) {
          finished = true;
          onEvent(
            stopped
              ? {
                  type: 'done',
                  text: 'Run stopped.',
                  isError: true,
                  errorKind: 'other',
                }
              : event,
          );
        }
      })().catch((error: unknown) => {
        finishing = undefined;
        throw error;
      }));
    const handle = async (value: unknown) => {
      const message = record(value),
        params = record(message.params);
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (message.method === 'session/request_permission') {
            const toolCall = record(params.toolCall);
            // Ask me each time: a command is run only after the owner approves this exact command.
            const asking =
              toolCall.kind === 'execute' && request.askCommand !== undefined;
            const known = record(
              tools.get(String(toolCall.toolCallId))?.rawInput,
            );
            const commandText = stringValue(
              record(toolCall.rawInput).command,
              '',
            );
            const permitted =
              !stopped &&
              params.sessionId === session &&
              (asking
                ? commandText !== '' &&
                  (await request.askCommand!({
                    command: commandText,
                    cwd: stringValue(known.cwd, request.cwd),
                  }).catch(() => false))
                : await (this.options.approvePermission
                    ? this.options.approvePermission(
                        request,
                        params.toolCall,
                        tools.get(String(record(params.toolCall).toolCallId)),
                        this.deps.canonical,
                      )
                    : approveAcpEdit(
                        request,
                        params.toolCall,
                        this.deps.canonical,
                      )));
            const allowed = permitted && !stopped && !closed;
            const options = Array.isArray(params.options)
              ? params.options.map(record)
              : [];
            const option = options.find(
              (o) => o.kind === (allowed ? 'allow_once' : 'reject_once'),
            );
            onEvent({
              type: 'tool',
              name: `${asking ? 'Command' : toolCall.kind === 'read' ? 'Read' : 'Edit'} ${allowed ? 'approved' : 'denied'}`,
              summary: asking
                ? commandText
                : stringValue(
                    record(record(params.toolCall).rawInput).tool,
                    stringValue(
                      record(record(params.toolCall).rawInput).filepath,
                      stringValue(
                        record(
                          tools.get(String(record(params.toolCall).toolCallId))
                            ?.rawInput,
                        ).filePath,
                        'Unknown permission',
                      ),
                    ),
                  ),
            });
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                outcome: option
                  ? { outcome: 'selected', optionId: option.optionId }
                  : { outcome: 'cancelled' },
              },
            });
          } else
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32601,
                message: 'Client capability not supported',
              },
            });
        } else if (
          message.method === 'session/update' &&
          active &&
          !stopped &&
          params.sessionId === session
        ) {
          const update = record(params.update),
            content = record(update.content);
          if (
            (update.sessionUpdate === 'tool_call' ||
              update.sessionUpdate === 'tool_call_update') &&
            typeof update.toolCallId === 'string'
          ) {
            const previous = tools.get(update.toolCallId) ?? {};
            tools.set(update.toolCallId, {
              ...previous,
              ...update,
              rawInput: {
                ...record(previous.rawInput),
                ...record(update.rawInput),
              },
            });
          }
          const cost = record(update.cost);
          if (
            update.sessionUpdate === 'usage_update' &&
            cost.currency === 'USD' &&
            typeof cost.amount === 'number' &&
            Number.isFinite(cost.amount) &&
            cost.amount >= 0
          )
            sessionCost = cost.amount;
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            content.type === 'text' &&
            typeof content.text === 'string'
          ) {
            text += content.text;
            onEvent({ type: 'text', text: content.text });
          }
          if (update.sessionUpdate === 'tool_call')
            onEvent({
              type: 'tool',
              name: stringValue(update.title, 'Tool'),
              summary: stringValue(
                record(update.rawInput).path,
                stringValue(
                  record(update.rawInput).filePath,
                  stringValue(update.title, 'Tool'),
                ),
              ),
            });
        }
      } else if (typeof message.id === 'number') {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
          p.reject(
            Error(
              stringValue(record(message.error).message, 'ACP request failed'),
            ),
          );
        else p.resolve(message.result);
      }
    };
    const begin = async () => {
      if (request.m365Launch) {
        const reason = m365UnavailableReason(this.id, true);
        if (reason) throw Error(reason);
      }
      if (request.canUseBrowser) {
        const reason = browserUnavailableReason(
          this.id,
          request.wholeComputerReadConfirmed ?? false,
          request.browserEngine ?? 'playwright',
          request.browserReadsConfirmed,
        );
        if (reason) throw Error(reason);
        // A private folder per run; removed when the run ends or is stopped.
        browserDir = mkdtempSync(join(tmpdir(), 'agenthq-browser-'));
        request.browserLaunch = await browserLaunchFor(
          this.options.browserHelper,
          browserDir,
        );
        if (stopped) return;
      }
      if (request.permission === 'full' || !request.protectedPaths?.length)
        throw Error(
          'ACP full permission is unavailable; protected folders are required.',
        );
      if (!this.executable) {
        const status = await this.detect();
        if (!status.available) throw Error(status.hint);
      }
      if (stopped) return;
      const executable = this.executable!;
      const prepared = await this.options.prepareEnv?.(request);
      if (stopped) return;
      child = this.deps.spawn(executable.file, executable.args, {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ...this.options.env,
          ...prepared,
          AGENTHQ_READ_ROOTS: JSON.stringify([
            request.cwd,
            ...(request.extraDirs ?? []),
            ...(request.readDirs ?? []),
          ]),
          AGENTHQ_WEB_ACCESS: String(request.webAccess ?? true),
          AGENTHQ_RUN_COMMANDS: request.askCommand
            ? 'ask'
            : String(request.runCommands === true),
        },
      });
      if (child.pid) this.pids.add(child.pid);
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (buffer.length > 8 * 1024 * 1024) {
          failPending(Error('ACP output exceeded the limit.'));
          return;
        }
        let n;
        while ((n = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          if (!line.trim()) continue;
          try {
            void handle(JSON.parse(line)).catch((error) =>
              failPending(
                error instanceof Error ? error : Error('ACP message failed'),
              ),
            );
          } catch {
            failPending(Error('Malformed ACP JSON output.'));
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-16000);
      });
      child.once('error', (error: Error) => failPending(error));
      for (const pipe of [child.stdin, child.stdout, child.stderr])
        pipe.on('error', (error: Error) => failPending(error));
      child.once('close', () => {
        closed = true;
        if (child?.pid) this.pids.delete(child.pid);
        failPending(Error(stderr || 'ACP process exited.'));
        resolveClosed();
      });
      const init = record(
        await rpc('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'agenthq', version: '0.1.0' },
        }),
      );
      if (
        init.protocolVersion !== 1 ||
        (this.options.policy
          ? record(init._meta).agenthqPolicy !== this.options.policy
          : !this.options.agentInfo ||
            record(init.agentInfo).name !== this.options.agentInfo.name ||
            record(init.agentInfo).version !== this.options.agentInfo.version)
      )
        throw Error('ACP safety policy is unavailable.');
      if (
        request.canUseBrowser &&
        this.options.browserPolicy &&
        record(init._meta).agenthqBrowser !== this.options.browserPolicy
      )
        throw Error('The browser policy of this runtime is unavailable.');
      if (
        request.m365Launch &&
        this.options.browserPolicy &&
        record(init._meta).agenthqM365 !== 'm365-v1'
      )
        throw Error('The Microsoft 365 policy of this runtime is unavailable.');
      // Hermes takes Mesa's own servers here (the browser and Microsoft 365, when switched on); others get none.
      const mcpServers = this.options.browserPolicy
        ? [
            ...(request.browserLaunch
              ? [
                  {
                    name: 'playwright',
                    ...browserServerCommand(request.browserLaunch),
                    env: [],
                  },
                ]
              : []),
            ...(request.m365Launch
              ? [
                  {
                    name: M365_SERVER,
                    ...m365ServerCommand(request.m365Launch),
                    env: [],
                  },
                ]
              : []),
          ]
        : [];
      if (request.resume) {
        session = request.sessionId;
        const loaded = await rpc('session/load', {
          sessionId: session,
          cwd: request.cwd,
          mcpServers,
        });
        if (loaded === null || loaded === undefined)
          throw Error('No conversation found for ACP session.');
      } else {
        const result = record(
          await rpc('session/new', { cwd: request.cwd, mcpServers }),
        );
        if (typeof result.sessionId !== 'string' || !result.sessionId)
          throw Error('ACP session ID is missing.');
        session = result.sessionId;
      }
      if (stopped) return;
      onEvent({ type: 'session', sessionId: session });
      await rpc('session/set_mode', {
        sessionId: session,
        modeId: this.options.mode ?? 'default',
      });
      if (request.model)
        await rpc('session/set_model', {
          sessionId: session,
          modelId: request.model,
        });
      active = true;
      const result = record(
        await rpc(
          'session/prompt',
          {
            sessionId: session,
            prompt: [
              {
                type: 'text',
                text: `Mesa instructions:\n${request.systemPrompt}\n\nUser message:\n${request.prompt}`,
              },
            ],
          },
          300000,
        ),
      );
      const cost =
        record(result._meta).agenthqCostUsd ??
        (sessionCost === undefined
          ? undefined
          : Math.max(0, sessionCost - (request.previousCostUsd ?? 0)));
      await finish({
        type: 'done',
        text,
        isError: result.stopReason !== 'end_turn',
        ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
          ? { costUsd: cost }
          : {}),
        ...(result.stopReason !== 'end_turn'
          ? { errorKind: 'other' as const }
          : {}),
      });
    };
    void begin()
      .catch(async (error: unknown) => {
        if (stopped || finished) return;
        const detail = error instanceof Error ? error.message : 'ACP failed';
        await finish({
          type: 'done',
          text: detail,
          isError: true,
          errorKind: /auth|credential|api.?key|provider.*config|log.?in/i.test(
            detail,
          )
            ? 'auth'
            : 'other',
        });
      })
      .catch(() => {});
    return {
      stop: async () => {
        if (finished) return;
        stopped = true;
        if (session && !closed)
          try {
            send({
              jsonrpc: '2.0',
              method: 'session/cancel',
              params: { sessionId: session },
            });
          } catch {
            /* Already closed. */
          }
        await finish({
          type: 'done',
          text: 'Run stopped.',
          isError: true,
          errorKind: 'other',
        });
      },
    };
  }
}
