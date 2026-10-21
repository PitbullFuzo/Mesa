import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promisify } from 'node:util';
import { killProcessTree } from './processTree';
import { findRuntimeExecutable, type Executable } from './detect';
import type { RuntimeAdapter, RuntimeStatus } from './types';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { browserUnavailableReason } from '../browser';
import {
  browserServerCommand,
  installedBrowserTools,
  safeAbsolutePath,
} from './browserTools';
import { tmpdir } from 'node:os';
import {
  M365_SERVER,
  m365ServerCommand,
  m365UnavailableReason,
} from '../m365/launch';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import type { RunEvent, RunRequest } from './types';

/** Flags checked against the installed CLI's --help; permission syntax:
 * https://code.claude.com/docs/en/permissions.md (absolute paths use //).
 * Restricted mode confines file tools and ignores untrusted settings. Safe
 * mode suppresses hooks/plugins while preserving the user's existing OAuth.
 */
export function buildRuntimeArgs(
  request: RunRequest,
  systemPromptFile: string,
): string[] {
  if (request.permission === 'full') {
    throw new Error(
      'Full permission is unavailable: bypass would disable protected-folder enforcement. Choose edit or read-only.',
    );
  }
  if (!request.protectedPaths?.length)
    throw new Error('Protected folders must be configured before running.');
  if (
    ![
      request.cwd,
      ...(request.extraDirs ?? []),
      ...(request.readDirs ?? []),
      ...request.protectedPaths,
    ].every(safeAbsolutePath)
  ) {
    throw new Error(
      'Runtime folders must be absolute local paths without traversal or permission-pattern characters.',
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      request.sessionId,
    )
  ) {
    throw new Error('The runtime session ID must be a UUID.');
  }
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  if (request.canUseBrowser) {
    const reason = browserUnavailableReason(
      'claude-code',
      request.wholeComputerReadConfirmed ?? false,
      request.browserEngine ?? 'playwright',
    );
    if (reason) throw Error(reason);
    const launch = request.browserLaunch;
    if (!launch) throw Error('Set up browser tools in Settings first.');
    if (!Object.values(launch).every(safeAbsolutePath))
      throw Error('Unsafe browser launch paths.');
    mcpServers.playwright = browserServerCommand(launch);
  }
  if (request.m365Launch) {
    const reason = m365UnavailableReason('claude-code', true);
    if (reason) throw Error(reason);
    mcpServers[M365_SERVER] = m365ServerCommand(request.m365Launch);
  }
  const mcpConfig = JSON.stringify({ mcpServers });
  const readTools = [
    'Read',
    'Glob',
    'Grep',
    ...(request.webAccess === false ? [] : ['WebSearch', 'WebFetch']),
  ];
  // Commands: Bash and PowerShell exist only for an agent allowed to run them (Allow freely). Off removes both.
  const commandTools =
    request.runCommands === true ? ['Bash', 'PowerShell'] : [];
  const tools = [...readTools, ...commandTools];
  if (request.permission === 'edit') tools.push('Edit', 'Write');
  const editRules = (path: string): string[] => {
    // The CLI normalizes C:\\... to /c/... before gitignore-style matching.
    // Only Edit(path) rules are consulted for file modifications (including
    // Write and NotebookEdit); scoped Write/NotebookEdit rules are ignored.
    const normalized = path
      .replace(/\\/g, '/')
      .replace(
        /^([a-z]):/i,
        (_match, drive: string) => '/' + drive.toLowerCase(),
      );
    const absolute = '//' + normalized.replace(/^\/+/, '').replace(/\/$/, '');
    return [`Edit(${absolute})`, `Edit(${absolute}/**)`];
  };
  const protectedRules = request.protectedPaths.flatMap(editRules);
  // dontAsk denies every unapproved edit, including read-only vault additions.
  const allowedTools = [
    ...readTools,
    ...(request.canUseBrowser ? ['mcp__playwright__*'] : []),
    ...(request.m365Launch ? [`mcp__${M365_SERVER}__*`] : []),
    ...commandTools,
    ...(request.permission === 'edit'
      ? [request.cwd, ...(request.extraDirs ?? [])].flatMap(editRules)
      : []),
  ];
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file',
    systemPromptFile,
    request.resume ? '--resume' : '--session-id',
    request.sessionId,
    // Verified in `claude --help`: --fork-session creates a new session ID when resuming.
    ...(request.resume && request.forkSession ? ['--fork-session'] : []),
    ...(request.canUseBrowser
      ? [
          '--setting-sources',
          '',
          '--settings',
          JSON.stringify({
            disableAllHooks: true,
            disableBundledSkills: true,
            autoMemoryEnabled: false,
            enableWorkflows: false,
            disableClaudeAiConnectors: true,
            claudeMdExcludes: ['**'],
            enabledPlugins: {
              'cc-plugin-agents-md@builtin': false,
              'agents-md@builtin': false,
            },
          }),
          '--disable-slash-commands',
          '--no-chrome',
        ]
      : ['--safe-mode']),
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    tools.join(','),
    '--allowedTools',
    allowedTools.join(','),
    '--disallowedTools',
    ...(request.runCommands === true ? [] : ['Bash', 'PowerShell']),
    'Agent',
    'Task',
    'NotebookEdit',
    ...(request.canUseBrowser || request.m365Launch ? [] : ['mcp__*']),
    ...protectedRules,
  ];
  if (request.model) args.push('--model', request.model);
  for (const directory of new Set([
    ...(request.extraDirs ?? []),
    ...(request.readDirs ?? []),
  ]))
    args.push('--add-dir', directory);
  return args;
}

export interface RuntimeOptions {
  browserHelper?: string;
  runtimePathOverride?: string;
  protectedPaths?: string[];
}
export interface RuntimeDependencies {
  killTree: (pid: number) => Promise<void>;
  findExecutable: typeof findRuntimeExecutable;
  probe: (file: string, args: string[]) => Promise<string>;
  spawn: (
    file: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}
const defaultDependencies: RuntimeDependencies = {
  killTree: killProcessTree,
  findExecutable: findRuntimeExecutable,
  probe: async (file, args) =>
    (
      await promisify(execFile)(file, args, {
        shell: false,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    ).stdout,
  spawn: (file, args, options) => spawn(file, args, options),
};
const installHint =
  'Install the runtime from https://code.claude.com/docs/en/setup or set Runtime path override to its native executable.';
export class ClaudeCodeRuntime implements RuntimeAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  private readonly pids = new Set<number>();
  private executable?: Executable;
  private readonly deps: RuntimeDependencies;
  constructor(
    private readonly options: RuntimeOptions = {},
    deps: Partial<RuntimeDependencies> = {},
  ) {
    this.deps = { ...defaultDependencies, ...deps };
  }
  get activePids(): readonly number[] {
    return [...this.pids];
  }
  async detect(): Promise<RuntimeStatus> {
    const executable = await this.deps.findExecutable({
      runtimePathOverride: this.options.runtimePathOverride,
    });
    if (!executable) {
      this.executable = undefined;
      return { available: false, hint: installHint };
    }
    try {
      const version = (
        await this.deps.probe(executable.file, [
          ...executable.args,
          '--version',
        ])
      ).trim();
      const help = await this.deps.probe(executable.file, [
        ...executable.args,
        '--help',
      ]);
      if (
        ![
          '--restricted',
          '--safe-mode',
          '--tools',
          '--permission-prompts',
          '--strict-mcp-config',
        ].every((flag) => help.includes(flag))
      ) {
        this.executable = undefined;
        return {
          available: false,
          path: executable.path,
          version,
          hint: 'Update the runtime: this version cannot enforce the required protected-folder policy.',
        };
      }
      this.executable = executable;
      return { available: true, version, path: executable.path };
    } catch {
      this.executable = undefined;
      return {
        available: false,
        path: executable.path,
        hint: 'The configured runtime could not start. Check its installation and path override.',
      };
    }
  }
  start(request: RunRequest, onEvent: (event: RunEvent) => void) {
    let stopped = false;
    let finished = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed = false;
    let promptDirectory: string | undefined;
    let resolveClosed: () => void = () => undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let stopping: Promise<void> | undefined;
    const emit = (event: RunEvent) => {
      if (finished) return;
      if (event.type === 'done') {
        finished = true;
        if (event.costUsd !== undefined && request.resume)
          event = {
            ...event,
            costUsd: Math.max(
              0,
              event.costUsd - (request.previousCostUsd ?? 0),
            ),
          };
        if (event.errorKind === 'auth')
          event = {
            ...event,
            text:
              event.text +
              '\nOpen a terminal, run `claude` once and sign in, then try again.',
          };
      }
      onEvent(event);
    };
    const stoppedEvent: RunEvent = {
      type: 'done',
      text: 'Run stopped.',
      isError: true,
      errorKind: 'other',
    };
    const cleanupPrompt = () => {
      if (!promptDirectory) return;
      try {
        rmSync(promptDirectory, { recursive: true, force: true });
        promptDirectory = undefined;
      } catch {
        emit({
          type: 'done',
          text: 'Could not remove the temporary runtime prompt file.',
          isError: true,
          errorKind: 'other',
        });
      }
    };
    const begin = async () => {
      const scopedRequest = {
        ...request,
        protectedPaths: [
          ...(this.options.protectedPaths ?? []),
          ...(request.protectedPaths ?? []),
        ],
      };
      // Validate before discovery or creating a temporary file.
      if (request.canUseBrowser) {
        const reason = browserUnavailableReason(
          this.id,
          request.wholeComputerReadConfirmed ?? false,
          request.browserEngine ?? 'playwright',
        );
        if (reason) throw Error(reason);
      }
      buildRuntimeArgs(
        { ...scopedRequest, canUseBrowser: false },
        'system.txt',
      );
      if (!this.executable) {
        const status = await this.detect();
        if (!status.available || !this.executable)
          throw Object.assign(new Error(status.hint ?? installHint), {
            code: status.path ? 'EPOLICY' : 'ENOENT',
          });
      }
      if (stopped) return;
      const executable = this.executable;
      if (request.canUseBrowser) {
        const version = (
          await this.deps.probe(executable.file, [
            ...executable.args,
            '--version',
          ])
        ).trim();
        if (version !== '2.1.286 (Claude Code)')
          throw Error(
            'Browser policy is verified only for Claude Code 2.1.286; refusing this version.',
          );
        if (stopped) return;
      }
      // Private per-run directory outside the vault; no prompt text on the command line.
      // Small synchronous file operations avoid a cancellation gap before spawn.
      promptDirectory = mkdtempSync(join(tmpdir(), 'agenthq-prompt-'));
      const systemPromptFile = join(promptDirectory, 'system.txt');
      writeFileSync(systemPromptFile, request.systemPrompt, {
        encoding: 'utf8',
        mode: 0o600,
      });
      if (request.canUseBrowser) {
        const launch = await installedBrowserTools();
        if (stopped) {
          cleanupPrompt();
          return;
        }
        if (!launch || !this.options.browserHelper)
          throw Error('Set up browser tools in Settings first.');
        const runDir = join(promptDirectory, 'browser');
        mkdirSync(runDir);
        scopedRequest.browserLaunch = {
          ...launch,
          helper: this.options.browserHelper,
          runDir,
        };
      }
      const args = buildRuntimeArgs(scopedRequest, systemPromptFile);
      child = this.deps.spawn(executable.file, [...executable.args, ...args], {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ...(request.canUseBrowser
            ? {
                CLAUDE_CODE_SAFE_MODE: '0',
                CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
              }
            : {}),
        },
      });
      if (child.pid) this.pids.add(child.pid);
      let terminal: Extract<RunEvent, { type: 'done' }> | undefined;
      const parser = new StreamJsonParser((event) => {
        if (event.type === 'done') terminal = event;
        else if (!stopped) emit(event);
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-16384);
      });
      child.once('error', (error: NodeJS.ErrnoException) =>
        parser.fail(
          error.message,
          error.code === 'ENOENT' ? 'not-found' : 'other',
        ),
      );
      child.stdout.on('data', (chunk: Buffer) => {
        if (!stopped) parser.push(chunk);
      });
      for (const pipe of [child.stdin, child.stdout, child.stderr]) {
        pipe.on('error', (error: Error) => parser.fail(error.message));
      }
      const pid = child.pid;
      child.once('close', (code: number | null) => {
        closed = true;
        cleanupPrompt();
        if (pid) this.pids.delete(pid);
        parser.end(
          code !== 0
            ? stderr.trim() || `Runtime exited with code ${String(code)}.`
            : undefined,
        );
        if (terminal && !terminal.isError && code !== 0) {
          const detail =
            stderr.trim() || `Runtime exited with code ${String(code)}.`;
          terminal = {
            ...terminal,
            text: [terminal.text, detail].filter(Boolean).join('\n'),
            isError: true,
            errorKind: errorKind(detail),
          };
        }
        if (stopped) emit(stoppedEvent);
        else if (terminal) emit(terminal);
        resolveClosed();
      });
      child.stdin.end(request.prompt, 'utf8');
    };
    void begin().catch((error: unknown) => {
      cleanupPrompt();
      emit({
        type: 'done',
        text:
          error instanceof Error ? error.message : 'Runtime could not start.',
        isError: true,
        errorKind:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'not-found'
            : 'other',
      });
    });
    return {
      stop: () => {
        if (stopping) return stopping;
        stopped = true;
        stopping = (async () => {
          if (child?.pid && !closed) {
            try {
              await this.deps.killTree(child.pid);
            } catch (error) {
              if (!closed) throw error;
            }
            await closePromise;
          } else emit(stoppedEvent);
        })().catch((error: unknown) => {
          // Keep the live PID tracked and permit an explicit teardown retry.
          stopping = undefined;
          throw error;
        });
        return stopping;
      },
    };
  }
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object'
    ? (value as JsonObject)
    : {};
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorKind(text: string): 'auth' | 'other' {
  return /authentication|unauthenticated|not logged|log.?in|sign.?in|invalid.{0,12}(api.?key|token)|401/i.test(
    text,
  )
    ? 'auth'
    : 'other';
}

export class StreamJsonParser {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private text = '';
  private partial = false;
  private finished = false;
  private readonly tools = new Set<string>();
  private readonly partialTools = new Map<
    unknown,
    { block: JsonObject; json: string }
  >();
  constructor(private readonly emit: (event: RunEvent) => void) {}

  push(chunk: Buffer | string) {
    this.pending +=
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
  }
  end(failureText = 'Runtime exited without a result.') {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.line(this.pending.trim());
    this.pending = '';
    if (!this.finished) this.fail(failureText);
  }
  fail(text: string, kind?: 'auth' | 'not-found' | 'other') {
    if (this.finished) return;
    this.finished = true;
    this.emit({
      type: 'done',
      text,
      isError: true,
      errorKind: kind ?? errorKind(text),
    });
  }
  private tool(block: JsonObject) {
    const id = string(block.id, string(block.name, 'Tool'));
    if (this.tools.has(id)) return;
    this.tools.add(id);
    const input = object(block.input);
    this.emit({
      type: 'tool',
      name: string(block.name, 'Tool'),
      summary: string(
        input.file_path,
        string(input.pattern, string(block.name, 'Tool')),
      ),
    });
  }
  private line(line: string) {
    if (!line || this.finished) return;
    let value: JsonObject;
    try {
      value = object(JSON.parse(line));
    } catch {
      this.fail('Runtime returned malformed stream output.');
      return;
    }
    if (
      value.type === 'system' &&
      value.subtype === 'init' &&
      typeof value.session_id === 'string' &&
      value.session_id.length > 0
    ) {
      this.emit({ type: 'session', sessionId: value.session_id });
      return;
    }
    if (value.type === 'error') {
      const detail = object(value.error);
      this.fail(
        string(
          detail.message,
          string(value.message, string(value.error, 'Runtime error.')),
        ),
      );
      return;
    }
    if (value.type === 'stream_event') {
      const event = object(value.event);
      const delta = object(event.delta);
      if (
        event.type === 'content_block_delta' &&
        delta.type === 'text_delta' &&
        typeof delta.text === 'string'
      ) {
        this.partial = true;
        this.text += delta.text;
        this.emit({ type: 'text', text: delta.text });
      }
      const block = object(event.content_block);
      if (event.type === 'content_block_start' && block.type === 'tool_use') {
        this.partialTools.set(event.index, { block, json: '' });
      }
      const pendingTool = this.partialTools.get(event.index);
      if (pendingTool && delta.type === 'input_json_delta')
        pendingTool.json += string(delta.partial_json);
      if (pendingTool && event.type === 'content_block_stop') {
        let input: unknown = pendingTool.block.input;
        try {
          if (pendingTool.json) input = JSON.parse(pendingTool.json);
        } catch {
          /* Fall back to the tool name; a complete envelope may follow. */
        }
        this.tool({ ...pendingTool.block, input });
        this.partialTools.delete(event.index);
      }
    }
    if (value.type === 'assistant') {
      const blocks = object(value.message).content;
      if (Array.isArray(blocks))
        for (const raw of blocks) {
          const block = object(raw);
          if (
            block.type === 'text' &&
            typeof block.text === 'string' &&
            !this.partial
          ) {
            this.text += block.text;
            this.emit({ type: 'text', text: block.text });
          }
          if (block.type === 'tool_use') this.tool(block);
        }
      this.partial = false;
    }
    if (value.type === 'rate_limit_event') {
      const windows = object(object(value.rate_limit_info).unifiedWindows);
      const pick = (raw: unknown) => {
        const window = object(raw);
        return typeof window.utilization === 'number' &&
          typeof window.resetsAt === 'number'
          ? { utilization: window.utilization, resetsAt: window.resetsAt }
          : undefined;
      };
      const fiveHour = pick(windows.five_hour);
      const sevenDay = pick(windows.seven_day);
      if (fiveHour || sevenDay)
        this.emit({
          type: 'plan-usage',
          usage: {
            ...(fiveHour ? { fiveHour } : {}),
            ...(sevenDay ? { sevenDay } : {}),
          },
        });
      return;
    }
    if (value.type === 'result') {
      const isError =
        value.is_error === true || string(value.subtype).startsWith('error');
      const details = Array.isArray(value.errors)
        ? value.errors.join('\n')
        : '';
      const text = string(value.result) || details || this.text;
      this.finished = true;
      this.emit({
        type: 'done',
        text,
        ...(typeof value.total_cost_usd === 'number'
          ? { costUsd: value.total_cost_usd }
          : {}),
        ...contextOf(value),
        isError,
        ...(isError ? { errorKind: errorKind(text) } : {}),
      });
    }
  }
}

/**
 * The conversation's context after the last reply: the last model call's input and output (the run total would count
 * every tool round again), with the window of the model that answered.
 */
function contextOf(result: JsonObject): {
  context?: { used: number; window?: number };
} {
  const usage = object(result.usage);
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const last = object(iterations.at(-1) ?? usage);
  const count = (key: string) =>
    typeof last[key] === 'number' ? last[key] : 0;
  const used =
    count('input_tokens') +
    count('cache_creation_input_tokens') +
    count('cache_read_input_tokens') +
    count('output_tokens');
  if (used <= 0) return {};
  const windows = Object.values(object(result.modelUsage))
    .map((entry) => object(entry).contextWindow)
    .filter((window): window is number => typeof window === 'number');
  return {
    context: {
      used,
      ...(windows.length ? { window: Math.min(...windows) } : {}),
    },
  };
}
