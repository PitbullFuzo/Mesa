import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promisify } from 'node:util';
import { killProcessTree } from './processTree';
import type { RuntimeAdapter, RuntimeStatus } from './types';
import { access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { pathWithin } from '../workdir';
import type { Executable } from './detect';
import { StringDecoder } from 'node:string_decoder';
import { record } from './acpPolicy';
import { mkdtempSync, rmSync } from 'node:fs';
import { browserUnavailableReason } from '../browser';
import { m365UnavailableReason } from '../m365/launch';
import { browserLaunchFor, browserServerCommand } from './browserTools';
import {
  parseVersion,
  VERIFIED_VERSIONS,
  versionVerdict,
} from './versionPolicy';
import {
  selfTestOnce,
  type SelfTestMemory,
  type SelfTestOutcome,
  type SelfTestRecord,
} from './selfTest';
import { runCodexSandboxSelfTest } from './codexSelfTest';
import type { RunRequest, RunEvent } from './types';
interface Detection {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}
export async function findCodex(
  options: Detection = {},
): Promise<Executable | undefined> {
  const windows = (options.platform ?? process.platform) === 'win32',
    env = options.env ?? process.env,
    api = windows ? win32 : posix,
    home = (windows ? env.USERPROFILE : env.HOME) ?? homedir();
  const exists =
    options.exists ??
    (async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    });
  const dirs = (
    Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  )
    .split(windows ? ';' : ':')
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => api.isAbsolute(p));
  dirs.push(
    api.join(home, '.local', 'bin'),
    ...(windows
      ? [
          api.join(
            env.LOCALAPPDATA ?? '',
            'Programs',
            'OpenAI',
            'Codex',
            'bin',
          ),
          api.join(env.APPDATA ?? '', 'npm'),
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          api.join(home, '.npm-global', 'bin'),
        ]),
  );
  for (const dir of dirs) {
    for (const name of windows
      ? [
          'codex.exe',
          ...(dir.endsWith(api.join('OpenAI', 'Codex', 'bin'))
            ? ['codex']
            : []),
        ]
      : ['codex']) {
      const file = api.join(dir, name);
      if (await exists(file)) return { file, args: [], path: file };
    }
    if (windows && (await exists(api.join(dir, 'codex.cmd')))) {
      for (const platform of ['codex-win32-x64', 'codex-win32-arm64']) {
        const triple = platform.endsWith('x64')
          ? 'x86_64-pc-windows-msvc'
          : 'aarch64-pc-windows-msvc';
        for (const prefix of [
          api.join(dir, 'node_modules'),
          api.join(dir, 'node_modules', '@openai', 'codex', 'node_modules'),
        ]) {
          const file = api.join(
            prefix,
            '@openai',
            platform,
            'vendor',
            triple,
            'codex',
            'codex.exe',
          );
          if (await exists(file)) return { file, args: [], path: file };
        }
      }
    }
  }
  return undefined;
}
export function buildCodexArgs(request: RunRequest): string[] {
  if (request.m365Launch) throw Error(m365UnavailableReason('codex', true));
  if (!request.wholeComputerReadConfirmed)
    throw Error(
      'Codex can read your whole computer. Confirm this access in Setup before running.',
    );
  if (request.canUseBrowser) {
    const reason = browserUnavailableReason(
      'codex',
      true,
      request.browserEngine ?? 'playwright',
      request.browserReadsConfirmed,
    );
    if (reason) throw Error(reason);
    if (!request.browserLaunch)
      throw Error('Set up browser tools in Settings first.');
  }
  if (request.permission === 'full')
    throw Error('Full permission is unavailable for Codex.');
  if (!request.protectedPaths?.length)
    throw Error('Codex requires protected folders.');
  const safe = (p: string) =>
    (/^[a-z]:[\\/]/i.test(p) || p.startsWith('/')) &&
    !p.startsWith('//') &&
    !p.startsWith('\\\\') &&
    ![...p].some((c) => c.charCodeAt(0) < 32 || '*?{}[]~$%'.includes(c)) &&
    !p
      .split(/[\\/]/)
      .some(
        (s, i) =>
          s === '.' ||
          s === '..' ||
          (/[a-z]:/i.test(request.cwd) &&
            (/[. ]$/.test(s) ||
              (s.includes(':') && !(i === 0 && /^[a-z]:$/i.test(s))))),
      );
  if (
    ![
      request.cwd,
      ...(request.extraDirs ?? []),
      ...request.protectedPaths,
    ].every(safe)
  )
    throw Error('Codex folders must be unambiguous absolute local paths.');
  if (
    request.resume &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      request.sessionId,
    )
  )
    throw Error('Codex resume requires a UUID session.');
  // Shared policy includes protected Attachments as readable add-dir for other runtimes.
  // Codex reads are broad; never turn those protected additions into writable roots.
  const extras = (request.extraDirs ?? []).filter(
    (root) => !request.protectedPaths!.some((p) => pathWithin(root, p)),
  );
  if (
    request.permission === 'edit' &&
    [request.cwd, ...extras].some((root) =>
      request.protectedPaths!.some(
        (p) => pathWithin(p, root) || pathWithin(root, p),
      ),
    )
  )
    throw Error(
      'Codex edit is unavailable when a writable root contains a protected folder. Choose a narrower work area.',
    );
  const args = [
    '--no-daemon',
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--strict-config',
    '-C',
    request.cwd,
    '-s',
    // Allow freely: no sandbox at all (no folder limits, internet on). Every other run stays sandboxed.
    request.runCommands === true
      ? 'danger-full-access'
      : request.permission === 'edit'
        ? 'workspace-write'
        : 'read-only',
  ];
  const settings: Record<string, unknown> = {
    approval_policy: 'never',
    model_reasoning_effort: 'low',
    web_search: request.webAccess === false ? 'disabled' : 'live',
    mcp_servers: {},
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    'sandbox_workspace_write.exclude_slash_tmp': true,
    project_doc_max_bytes: 0,
    'skills.include_instructions': false,
    'shell_environment_policy.inherit': 'core',
    allow_login_shell: false,
    'features.code_mode_host': true,
    notify: [],
    check_for_update_on_startup: false,
  };
  for (const feature of [
    'apps',
    'plugins',
    'hooks',
    'multi_agent',
    'multi_agent_v2',
    'memories',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'computer_use',
    'in_app_browser',
    'image_generation',
    'code_mode',
    'code_mode_only',
    'skill_search',
    'shell_snapshot',
    'workspace_dependencies',
    'network_proxy',
    'request_permissions_tool',
    'guardian_approval',
  ])
    settings['features.' + feature] = false;
  if (process.platform === 'win32') settings['windows.sandbox'] = 'unelevated';
  // The browser run gets exactly one MCP server, Mesa's helper; every other run keeps the empty list above.
  if (request.canUseBrowser && request.browserLaunch) {
    const { command, args: serverArgs } = browserServerCommand(
      request.browserLaunch,
    );
    settings['mcp_servers.agenthq_browser.command'] = command;
    settings['mcp_servers.agenthq_browser.args'] = serverArgs;
  }
  for (const [k, v] of Object.entries(settings))
    args.push('-c', k + '=' + JSON.stringify(v));
  if (request.model) args.push('-m', request.model);
  if (request.permission === 'edit')
    for (const root of new Set(extras)) args.push('--add-dir', root);
  // Verified in `codex exec fork --help`: fork a session by id into a new one; the prompt comes on stdin.
  if (request.resume)
    args.push(request.forkSession ? 'fork' : 'resume', request.sessionId);
  args.push('-');
  return args;
}
export interface CodexDependencies {
  find: () => Promise<Executable | undefined>;
  probe: (file: string, args: string[]) => Promise<string>;
  spawn: (
    file: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  killTree: (pid: number) => Promise<void>;
  /** Remembered self-test results per version (kept in the plugin's data). */
  selfTests: SelfTestMemory;
  rememberSelfTest: (key: string, record: SelfTestRecord) => void;
  /** The free sandbox self-test for a newer version. */
  selfTest: (file: string) => Promise<SelfTestOutcome>;
  /** Where Mesa's browser helper is installed; browser runs are refused without it. */
  browserHelper?: string;
}
export class CodexRuntime implements RuntimeAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  private executable?: Executable;
  private pids = new Set<number>();
  private pendingSelfTests = new Map<string, Promise<SelfTestOutcome>>();
  private deps: CodexDependencies;
  constructor(deps: Partial<CodexDependencies> = {}) {
    this.deps = {
      find: findCodex,
      probe: async (file, args) =>
        (
          await promisify(execFile)(file, args, {
            shell: false,
            windowsHide: true,
            timeout: 15000,
          })
        ).stdout,
      spawn,
      killTree: killProcessTree,
      selfTests: {},
      rememberSelfTest: () => undefined,
      selfTest: (file) =>
        runCodexSandboxSelfTest(
          file,
          join(
            process.env.LOCALAPPDATA ?? homedir(),
            'Mesa',
            'selfTest',
            'codex',
          ),
        ),
      ...deps,
    };
  }
  get activePids() {
    return [...this.pids];
  }
  async detect(): Promise<RuntimeStatus> {
    try {
      this.executable = await this.deps.find();
      if (!this.executable)
        return {
          available: false,
          hint: 'Install the Codex CLI separately and run codex login. Native PATH, desktop bin, npm and Homebrew locations are checked.',
        };
      const version = (
        await this.deps.probe(this.executable.file, ['--version'])
      ).trim();
      const verdict = versionVerdict(version, VERIFIED_VERSIONS.codex);
      if (verdict === 'verified')
        return { available: true, version, path: this.executable.path };
      if (verdict === 'newer') {
        // A newer Codex runs only after the free sandbox self-test passes once for that version.
        const key = `codex ${parseVersion(version)}`;
        const file = this.executable.file;
        const outcome = await selfTestOnce(
          key,
          this.deps.selfTests,
          this.deps.rememberSelfTest,
          this.pendingSelfTests,
          () => this.deps.selfTest(file),
        );
        if (outcome.result === 'pass')
          return {
            available: true,
            version,
            path: this.executable.path,
            hint: `Checked by Mesa, not yet verified by the developer (${key}).`,
          };
        this.executable = undefined;
        // A real breach is blocked; a check that could not finish is only "not ready yet" and is retried later.
        if (outcome.result === 'unsupported')
          return { available: false, version, hint: outcome.detail };
        return {
          available: false,
          version,
          blocked: true,
          hint: `This Codex version changed its safety settings. Use ${VERIFIED_VERSIONS.codex} or wait for an Mesa update. (${outcome.detail})`,
        };
      }
      this.executable = undefined;
      return {
        available: false,
        version,
        blocked: verdict === 'older',
        hint: `Codex ${VERIFIED_VERSIONS.codex} or newer is required. Older versions are blocked.`,
      };
    } catch {
      this.executable = undefined;
      return {
        available: false,
        hint: 'Codex could not start; check its native CLI installation.',
      };
    }
  }
  start(request: RunRequest, onEvent: (e: RunEvent) => void) {
    let child: ChildProcessWithoutNullStreams | undefined,
      closed = false,
      stopped = false,
      finished = false,
      terminal: Extract<RunEvent, { type: 'done' }> | undefined,
      stderr = '';
    let stopping: Promise<void> | undefined;
    let termination: Promise<void> | undefined;
    const terminate = () =>
      (termination ??= Promise.resolve().then(async () => {
        if (child?.pid && !closed) {
          try {
            await this.deps.killTree(child.pid);
          } catch (e) {
            if (!closed) {
              termination = undefined;
              throw e;
            }
          }
        }
      }));
    let resolveClosed = () => {};
    const closing = new Promise<void>((r) => (resolveClosed = r));
    const emit = (e: RunEvent) => {
      if (finished) return;
      if (e.type === 'done') finished = true;
      onEvent(e);
    };
    let browserDir: string | undefined;
    const removeBrowserDir = () => {
      if (browserDir) rmSync(browserDir, { recursive: true, force: true });
      browserDir = undefined;
    };
    const begin = async () => {
      const scoped = { ...request };
      if (request.canUseBrowser) {
        // Check the policy first, so a refused run creates nothing.
        const reason = browserUnavailableReason(
          'codex',
          request.wholeComputerReadConfirmed ?? false,
          request.browserEngine ?? 'playwright',
          request.browserReadsConfirmed,
        );
        if (reason) throw Error(reason);
        browserDir = mkdtempSync(join(tmpdir(), 'agenthq-browser-'));
        scoped.browserLaunch = await browserLaunchFor(
          this.deps.browserHelper,
          browserDir,
        );
      }
      const args = buildCodexArgs(scoped);
      if (!this.executable) {
        const status = await this.detect();
        if (!status.available || !this.executable) throw Error(status.hint);
      }
      if (stopped) {
        removeBrowserDir();
        return;
      }
      child = this.deps.spawn(this.executable.file, args, {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env },
      });
      const pid = child.pid;
      if (pid) this.pids.add(pid);
      const parser = new CodexParser((e) => {
        if (e.type === 'done') {
          terminal = e;
          if (e.isError && !closed) void terminate().catch(() => {});
        } else if (!stopped) emit(e);
      });
      child.stdout.on('data', (d: Buffer) => {
        if (!stopped) parser.push(d);
      });
      child.stderr.on(
        'data',
        (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-16000)),
      );
      child.once('error', (e: Error) => parser.fail(e.message));
      for (const pipe of [child.stdin, child.stdout, child.stderr])
        pipe.on('error', (e: Error) => parser.fail(e.message));
      child.once('close', (code: number | null) => {
        const complete = () => {
          closed = true;
          if (pid) this.pids.delete(pid);
          removeBrowserDir();
          parser.end(stderr || undefined);
          if (stopped)
            emit({
              type: 'done',
              text: 'Run stopped.',
              isError: true,
              errorKind: 'other',
            });
          else if (code !== 0)
            emit({
              type: 'done',
              text:
                stderr ||
                terminal?.text ||
                `Codex exited with code ${String(code)}.`,
              isError: true,
              errorKind: terminal?.errorKind ?? 'other',
            });
          else if (terminal) emit(terminal);
          resolveClosed();
        };
        closed = true;
        if (termination) void termination.then(complete, complete);
        else complete();
      });
      try {
        child.stdin.end(
          `Mesa instructions:\n${request.systemPrompt}\n\nUser message:\n${request.prompt}`,
          'utf8',
        );
      } catch (error) {
        parser.fail(
          error instanceof Error ? error.message : 'Codex input failed.',
        );
      }
    };
    void begin().catch((e: unknown) => {
      removeBrowserDir();
      emit({
        type: 'done',
        text: e instanceof Error ? e.message : 'Codex could not start.',
        isError: true,
        errorKind: 'other',
      });
    });
    return {
      stop: () => {
        if (stopping) return stopping;
        stopped = true;
        stopping = (async () => {
          if (child?.pid && !closed) {
            try {
              await terminate();
            } catch (e) {
              if (!closed) throw e;
            }
            await closing;
          } else {
            removeBrowserDir();
            emit({
              type: 'done',
              text: 'Run stopped.',
              isError: true,
              errorKind: 'other',
            });
          }
        })().catch((e) => {
          stopping = undefined;
          throw e;
        });
        return stopping;
      },
    };
  }
}
export class CodexParser {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private text = '';
  private finished = false;
  private messages = new Map<string, string>();
  private tools = new Set<string>();
  constructor(private emit: (event: RunEvent) => void) {}
  push(chunk: Buffer | string) {
    if (this.finished) return;
    this.pending +=
      typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (this.pending.length > 8 * 1024 * 1024) {
      this.fail('Codex stream exceeded the output limit.');
      return;
    }
    let n: number;
    while ((n = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, n);
      this.pending = this.pending.slice(n + 1);
      if (line.trim()) this.line(line);
    }
  }
  end(error = 'Codex exited without a completed turn.') {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.line(this.pending);
    if (!this.finished) this.fail(error);
  }
  fail(text: string) {
    if (this.finished) return;
    this.finished = true;
    this.emit({
      type: 'done',
      text,
      isError: true,
      errorKind: /auth|401|log.?in|sign.?in/i.test(text) ? 'auth' : 'other',
    });
  }
  private line(line: string) {
    if (this.finished) return;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      this.fail('Codex returned malformed JSONL.');
      return;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string')
      this.emit({ type: 'session', sessionId: event.thread_id });
    if (
      event.type === 'item.updated' ||
      event.type === 'item.completed' ||
      event.type === 'item.started'
    ) {
      const item = record(event.item),
        id = String(item.id);
      if (item.type === 'error') {
        this.fail(
          typeof item.message === 'string'
            ? item.message
            : 'Codex item failed.',
        );
        return;
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        const previous = this.messages.get(id) ?? '';
        if (!item.text.startsWith(previous)) {
          this.fail('Codex message update was inconsistent.');
          return;
        }
        const delta = item.text.slice(previous.length);
        this.messages.set(id, item.text);
        this.text += delta;
        if (delta) this.emit({ type: 'text', text: delta });
      } else if (
        [
          'command_execution',
          'file_change',
          'web_search',
          'mcp_tool_call',
          'collab_tool_call',
        ].includes(String(item.type)) &&
        !this.tools.has(id)
      ) {
        this.tools.add(id);
        this.emit({
          type: 'tool',
          name: String(item.type),
          summary:
            typeof item.command === 'string'
              ? item.command
              : typeof item.query === 'string'
                ? item.query
                : JSON.stringify(item.changes ?? item.type),
        });
      }
    }
    if (event.type === 'turn.failed')
      this.fail(
        typeof record(event.error).message === 'string'
          ? (record(event.error).message as string)
          : 'Codex turn failed.',
      );
    if (event.type === 'error')
      this.fail(
        typeof event.message === 'string' ? event.message : 'Codex error.',
      );
    if (event.type === 'turn.completed') {
      const usage = record(event.usage);
      this.emit({
        type: 'tool',
        name: 'Usage',
        summary: `${typeof usage.input_tokens === 'number' ? usage.input_tokens : '?'} input / ${typeof usage.output_tokens === 'number' ? usage.output_tokens : '?'} output tokens (Codex reports tokens, not dollars).`,
      });
      this.finished = true;
      this.emit({
        type: 'done',
        text: this.text,
        isError: false,
        ...(typeof usage.input_tokens === 'number' &&
        typeof usage.output_tokens === 'number'
          ? {
              tokens: {
                input: usage.input_tokens,
                output: usage.output_tokens,
              },
              // Codex does not report the model's window, so this shows tokens without a percentage.
              context: { used: usage.input_tokens + usage.output_tokens },
            }
          : {}),
      });
    }
  }
}
