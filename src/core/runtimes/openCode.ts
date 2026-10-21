import { access, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { AcpRuntime } from './acp';
import { browserServerCommand } from './browserTools';
import { M365_SERVER, m365ServerCommand } from '../m365/launch';
import { approveAcpEdit, canonicalFile, record } from './acpPolicy';
import { pathWithin } from '../workdir';
import type { Executable } from './detect';
import type { RunRequest } from './types';
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
const FREE_MODEL = 'opencode/nemotron-3.5-lightning-free';
interface Detection {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}
export async function findOpenCode(
  options: Detection = {},
): Promise<Executable | undefined> {
  const platform = options.platform ?? process.platform,
    env = options.env ?? process.env,
    windows = platform === 'win32',
    path = windows ? win32 : posix;
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
  const home = (windows ? env.USERPROFILE : env.HOME) ?? homedir();
  const dirs = (
    Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  )
    .split(windows ? ';' : ':')
    .filter(Boolean)
    .map((p) => p.replace(/^"|"$/g, ''));
  dirs.push(
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    ...(windows
      ? [
          path.join(env.LOCALAPPDATA ?? '', 'hermes', 'node'),
          path.join(env.APPDATA ?? '', 'npm'),
        ]
      : ['/opt/homebrew/bin', '/usr/local/bin']),
  );
  for (const dir of dirs) {
    const native = path.join(dir, windows ? 'opencode.exe' : 'opencode');
    if (await exists(native))
      return { file: native, args: ['acp', '--pure'], path: native };
    if (windows && (await exists(path.join(dir, 'opencode.cmd')))) {
      const file = path.join(
        dir,
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe',
      );
      if (await exists(file))
        return { file, args: ['acp', '--pure'], path: file };
    }
  }
  return undefined;
}
export function openCodeEnvironment(
  request: RunRequest,
  state: string,
): NodeJS.ProcessEnv {
  // The browser run gets exactly one MCP server, Obi-I's helper, and permission for only that server's tools.
  const browser = request.browserLaunch
    ? browserServerCommand(request.browserLaunch)
    : undefined;
  // Microsoft 365: Obi-I's helper is the only other server, with permission for only its tools.
  const m365 = request.m365Launch
    ? m365ServerCommand(request.m365Launch)
    : undefined;
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of [
    ['playwright', browser],
    [M365_SERVER, m365],
  ] as const)
    if (server)
      mcp[name] = {
        type: 'local',
        command: [server.command, ...server.args],
        enabled: true,
      };
  const permission = {
    '*': 'deny',
    ...(browser ? { 'playwright_*': 'allow' } : {}),
    ...(m365 ? { [`${M365_SERVER}_*`]: 'allow' } : {}),
    read: 'ask',
    edit: request.permission === 'edit' ? 'ask' : 'deny',
    bash: request.askCommand
      ? 'ask'
      : request.runCommands === true
        ? 'allow'
        : 'deny',
    task: 'deny',
    glob: 'deny',
    grep: 'deny',
    external_directory: 'allow',
    // Native URL fetch has no private-network/redirect confinement. Search only.
    webfetch: 'deny',
    websearch: request.webAccess === false ? 'deny' : 'allow',
  };
  const config = {
    model: request.model || FREE_MODEL,
    small_model: request.model || FREE_MODEL,
    default_agent: 'agenthq',
    agent: {
      agenthq: {
        mode: 'primary',
        description: 'Obi-I confined file tools',
        permission,
      },
      title: { disable: true },
    },
    permission,
    formatter: false,
    lsp: false,
    snapshot: false,
    share: 'disabled',
    autoupdate: false,
    compaction: { auto: false, prune: false },
    instructions: [],
    mcp,
  };
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith('OPENCODE_'))
        .map((k) => [k, undefined]),
    ),
    XDG_CONFIG_HOME: state + '/config',
    XDG_DATA_HOME: state + '/data',
    XDG_CACHE_HOME: state + '/cache',
    XDG_STATE_HOME: state + '/state',
    OPENCODE_TEST_HOME: state + '/home',
    OPENCODE_CONFIG_DIR: state + '/config/opencode',
    OPENCODE_DB: state + '/state.db',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
  };
}
/** Native read permission metadata is empty: require the matching streamed tool input. */
export async function approveOpenCode(
  request: RunRequest,
  value: unknown,
  known: unknown,
  canonical = canonicalFile,
): Promise<boolean> {
  const call = record(value),
    cached = record(known),
    raw = record(call.rawInput),
    input = record(cached.rawInput);
  const original = input.filePath;
  if (
    typeof original !== 'string' ||
    !original ||
    !['read', 'edit'].includes(String(cached.kind)) ||
    call.kind !== cached.kind
  )
    return false;
  const api = /^[a-z]:[\\/]/i.test(request.cwd) ? win32 : posix;
  const comparable = (p: string) => (api === win32 ? p.toLowerCase() : p);
  const path = api.resolve(request.cwd, original).replace(/\\/g, '/');
  if (
    original.startsWith('//') ||
    (api === win32 && /^[\\/]/.test(original)) ||
    [...original].some(
      (c) => c.charCodeAt(0) < 32 || '*?{}[],$%~'.includes(c),
    ) ||
    original
      .split(/[\\/]/)
      .some(
        (p, i) =>
          p === '..' ||
          p === '.' ||
          (/[a-z]:/i.test(request.cwd) &&
            (/[. ]$/.test(p) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(p) ||
              (p.includes(':') && !(i === 0 && /^[a-z]:$/i.test(p))))),
      )
  )
    return false;
  if (call.kind === 'edit') {
    if (
      raw.files !== undefined ||
      raw.movePath !== undefined ||
      typeof raw.filepath !== 'string' ||
      comparable(api.resolve(request.cwd, raw.filepath).replace(/\\/g, '/')) !==
        comparable(path.replace(/\\/g, '/'))
    )
      return false;
    return approveAcpEdit(
      request,
      { ...call, rawInput: { tool: 'write_file', arguments: { path } } },
      canonical,
    );
  }
  if (call.kind !== 'read') return false;
  try {
    const roots = [
      request.cwd,
      ...(request.extraDirs ?? []),
      ...(request.readDirs ?? []),
    ];
    const allowed = async (p: string) => {
      const target = (await canonical(p.replace(/\\/g, '/'))).replace(
        /\\/g,
        '/',
      );
      return (
        roots.some((root) => pathWithin(target, root)) &&
        roots.some((root) => pathWithin(p.replace(/\\/g, '/'), root))
      );
    };
    if (!(await allowed(path))) return false;
    // Native read attaches nearby instruction files without a separate permission.
    // Refuse the read if one of those instruction paths canonically escapes roots.
    let dir = api.normalize(api.dirname(path));
    const cwd = api.normalize(request.cwd);
    while (
      comparable(dir).startsWith(comparable(cwd)) &&
      comparable(dir) !== comparable(cwd)
    ) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'])
        if (!(await allowed(api.join(dir, name)))) return false;
      const parent = api.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return true;
  } catch {
    return false;
  }
}
/** The problem with the effective OpenCode policy, or undefined when it matches Obi-I's policy. */
export function openCodePolicyProblem(
  stdout: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const config = record(JSON.parse(stdout) as unknown),
    agent = record(record(config.agent).agenthq);
  const wanted = record(JSON.parse(env.OPENCODE_PERMISSION!) as unknown);
  const wantedMcp = record(
    record(JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as unknown).mcp,
  );
  return config.formatter !== false ||
    config.lsp !== false ||
    config.snapshot !== false ||
    JSON.stringify(config.mcp ?? {}) !== JSON.stringify(wantedMcp) ||
    JSON.stringify(config.instructions) !== '[]' ||
    agent.mode !== 'primary' ||
    JSON.stringify(agent.permission) !== JSON.stringify(wanted)
    ? 'OpenCode effective policy differs from Obi-I; run refused.'
    : undefined;
}

/**
 * The free OpenCode self-test for a newer version: prints the effective policy with Obi-I's environment and
 * compares it with the policy. No model call.
 */
async function runOpenCodeSelfTest(
  file: string,
  state: string,
): Promise<SelfTestOutcome> {
  await mkdir(state, { recursive: true });
  const probe: RunRequest = {
    prompt: '',
    systemPrompt: '',
    cwd: state,
    sessionId: '',
    resume: false,
    permission: 'edit',
    protectedPaths: [],
  };
  const env = openCodeEnvironment(probe, state);
  // A run that fails, times out or prints nothing readable is retried later; only a readable policy that
  // differs from Obi-I's is a real breach.
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      file,
      ['debug', 'config', '--pure'],
      {
        cwd: state,
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      },
    ));
  } catch {
    return {
      result: 'unsupported',
      detail: 'OpenCode did not answer the policy check. Will retry.',
    };
  }
  let problem: string | undefined;
  try {
    problem = openCodePolicyProblem(stdout, env);
  } catch {
    return {
      result: 'unsupported',
      detail: 'OpenCode could not print its effective policy. Will retry.',
    };
  }
  return problem
    ? {
        result: 'fail',
        detail: 'the effective OpenCode policy differs from Obi-I',
      }
    : {
        result: 'pass',
        detail: 'the effective OpenCode policy matches Obi-I',
      };
}

export interface OpenCodeOptions {
  browserHelper?: string;
  selfTests?: SelfTestMemory;
  rememberSelfTest?: (key: string, record: SelfTestRecord) => void;
}

export function createOpenCodeRuntime(options: OpenCodeOptions = {}) {
  const state = join(
    process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
    'Obi-I',
    'opencode',
  );
  const selfTests = options.selfTests ?? {};
  const remember = options.rememberSelfTest ?? (() => undefined);
  const pending = new Map<string, Promise<SelfTestOutcome>>();
  let executable: Executable | undefined;
  return new AcpRuntime({
    id: 'opencode',
    displayName: 'OpenCode',
    agentInfo: { name: 'OpenCode', version: VERIFIED_VERSIONS.opencode },
    mode: 'agenthq',
    browserHelper: options.browserHelper,
    missingHint: `Install the OpenCode CLI separately from its desktop app (opencode-ai). Reinstall if a private Node update removed it. ${VERIFIED_VERSIONS.opencode} or newer is required; newer versions are checked once by Obi-I.`,
    resolve: async () => {
      executable = await findOpenCode();
      if (!executable) return;
      const file = executable.file;
      const result = await promisify(execFile)(file, ['--version'], {
        shell: false,
        windowsHide: true,
        timeout: 15000,
      });
      const reported = result.stdout.trim();
      const verdict = versionVerdict(reported, VERIFIED_VERSIONS.opencode);
      if (verdict === 'older' || verdict === 'unknown')
        throw Error(
          `OpenCode ${VERIFIED_VERSIONS.opencode} or newer is required. Older versions are blocked.`,
        );
      if (verdict === 'newer') {
        const key = `opencode ${parseVersion(reported)}`;
        const outcome = await selfTestOnce(
          key,
          selfTests,
          remember,
          pending,
          () => runOpenCodeSelfTest(file, state),
        );
        if (outcome.result === 'unsupported')
          throw Error(
            `Can't check this OpenCode version now: ${outcome.detail}`,
          );
        if (outcome.result !== 'pass')
          throw Error(
            `This OpenCode version changed its safety settings. Use ${VERIFIED_VERSIONS.opencode} or wait for an Obi-I update.`,
          );
      }
      return { ...executable, version: reported };
    },
    prepareEnv: async (request) => {
      await mkdir(state, { recursive: true });
      const env = openCodeEnvironment(request, state);
      const { stdout } = await promisify(execFile)(
        executable!.file,
        ['debug', 'config', '--pure'],
        {
          cwd: request.cwd,
          env: { ...process.env, ...env },
          shell: false,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const problem = openCodePolicyProblem(stdout, env);
      if (problem) throw Error(problem);
      return env;
    },
    approvePermission: approveOpenCode,
  });
}
