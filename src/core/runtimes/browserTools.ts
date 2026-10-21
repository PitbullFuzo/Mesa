import { access, readFile, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import type { BrowserStatus } from '../browser';
import type { RunRequest } from './types';
export const PLAYWRIGHT_VERSION = '0.0.83';
export interface BrowserNode {
  node: string;
  npm: string;
  npx: string;
}
interface Discovery {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => Promise<boolean>;
  readdir?: (p: string) => Promise<string[]>;
}
const exists = async (p: string) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
export function browserCachePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  const api = platform === 'win32' ? win32 : posix,
    home = env.HOME ?? env.USERPROFILE ?? homedir();
  return platform === 'win32'
    ? api.join(
        env.LOCALAPPDATA ?? api.join(home, 'AppData', 'Local'),
        'ms-playwright',
      )
    : platform === 'darwin'
      ? api.join(home, 'Library', 'Caches', 'ms-playwright')
      : api.join(
          env.XDG_CACHE_HOME ?? api.join(home, '.cache'),
          'ms-playwright',
        );
}
export async function findBrowserNode(
  options: Discovery = {},
): Promise<BrowserNode | undefined> {
  const platform = options.platform ?? process.platform,
    env = options.env ?? process.env,
    windows = platform === 'win32',
    api = windows ? win32 : posix,
    home = (windows ? env.USERPROFILE : env.HOME) ?? homedir(),
    has = options.exists ?? exists;
  const dirs = (
    Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? ''
  )
    .split(windows ? ';' : ':')
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => api.isAbsolute(p));
  dirs.push(
    ...(windows
      ? [api.join(env.LOCALAPPDATA ?? '', 'hermes', 'node')]
      : ['/opt/homebrew/bin', '/usr/local/bin']),
    api.join(home, '.local', 'bin'),
    api.join(home, '.npm-global', 'bin'),
  );
  if (!windows) {
    const root = api.join(home, '.nvm', 'versions', 'node');
    const versions = await (options.readdir ?? readdir)(root).catch(() => []);
    versions
      .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((v) => dirs.push(api.join(root, v, 'bin')));
  }
  for (const dir of dirs) {
    const node = api.join(dir, windows ? 'node.exe' : 'node');
    if (!(await has(node))) continue;
    for (const root of [
      api.join(dir, 'node_modules', 'npm', 'bin'),
      api.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin'),
    ]) {
      const npm = api.join(root, 'npm-cli.js'),
        npx = api.join(root, 'npx-cli.js');
      if ((await has(npm)) && (await has(npx))) return { node, npm, npx };
    }
  }
  return undefined;
}
export interface BrowserInstallation extends BrowserNode {
  server: string;
  browser: string;
  cache: string;
}
export function browserToolsHome() {
  return join(
    process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
    'Mesa',
    'browser-tools',
  );
}
const exec = promisify(execFile);
export async function installedBrowserTools(): Promise<
  BrowserInstallation | undefined
> {
  const node = await findBrowserNode();
  if (!node) return;
  const root = browserToolsHome(),
    server = join(root, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    core = join(root, 'node_modules', 'playwright-core');
  try {
    const metadata = JSON.parse(
      await readFile(
        join(root, 'node_modules', '@playwright', 'mcp', 'package.json'),
        'utf8',
      ),
    ) as { version?: string };
    if (metadata.version !== PLAYWRIGHT_VERSION || !(await exists(server)))
      return;
    const cache = browserCachePath();
    const { stdout } = await exec(
      node.node,
      [
        '-e',
        'process.stdout.write(require(process.argv[1]).chromium.executablePath())',
        core,
      ],
      {
        shell: false,
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: cache,
          NODE_OPTIONS: undefined,
          NODE_PATH: undefined,
        },
      },
    );
    const browser = stdout.trim();
    if (await exists(browser)) return { ...node, server, browser, cache };
    return undefined;
  } catch {
    return;
  }
}
export async function browserToolsStatus(): Promise<BrowserStatus> {
  const available = !!(await installedBrowserTools());
  return {
    engine: 'playwright',
    available,
    hint: available
      ? 'Playwright ready: isolated profiles; no saved logins/cookies.'
      : 'Install Node.js with npm/npx, then use Settings → Mesa → Set up browser tools. No shell shim is executed.',
  };
}
export function browserInstallArgs(
  node: BrowserNode,
  root: string,
): string[][] {
  return [
    [
      node.npm,
      'install',
      '--prefix',
      root,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '@playwright/mcp@' + PLAYWRIGHT_VERSION,
    ],
    [
      join(root, 'node_modules', 'playwright', 'cli.js'),
      'install',
      'chromium',
      '--no-shell',
      '--no-remove',
    ],
  ];
}
export async function installBrowserTools(): Promise<void> {
  const node = await findBrowserNode();
  if (!node) throw Error('Install Node.js with npm/npx first.');
  const root = browserToolsHome();
  await mkdir(root, { recursive: true });
  const options = {
    shell: false as const,
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
      PLAYWRIGHT_BROWSERS_PATH: browserCachePath(),
    },
  };
  for (const args of browserInstallArgs(node, root))
    await exec(node.node, args, options);
  if (!(await installedBrowserTools()))
    throw Error('Browser installation did not pass detection.');
}
export type BrowserLaunch = NonNullable<RunRequest['browserLaunch']>;
export function safeAbsolutePath(path: string): boolean {
  return (
    (posix.isAbsolute(path) || /^[a-z]:[\\/]/i.test(path)) &&
    ![...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || '*?[]{}(),'.includes(character),
    ) &&
    !path.startsWith('\\\\') &&
    !path.startsWith('//') &&
    !path
      .split(/[\\/]/)
      .some(
        (part) =>
          part === '.' ||
          part === '..' ||
          (/^[a-z]:[\\/]/i.test(path) && /[. ]$/.test(part)),
      )
  );
}

/** The one MCP server every runtime gets for a browser run: Mesa's policy helper around Playwright MCP. */
export function browserServerCommand(launch: BrowserLaunch): {
  command: string;
  args: string[];
} {
  if (!Object.values(launch).every(safeAbsolutePath))
    throw Error('Unsafe browser launch paths.');
  return {
    command: launch.node,
    args: [
      launch.helper,
      '--agenthq-browser',
      '--isolated',
      '--server',
      launch.server,
      '--browser',
      launch.browser,
      '--run-dir',
      launch.runDir,
      '--cache',
      launch.cache,
    ],
  };
}
/** The launch for one run in `runDir` (a private folder the caller removes afterwards). */
export async function browserLaunchFor(
  helper: string | undefined,
  runDir: string,
): Promise<BrowserLaunch> {
  const installed = await installedBrowserTools();
  if (!installed || !helper)
    throw Error('Set up browser tools in Settings first.');
  const { node, server, browser, cache } = installed;
  return { node, server, browser, cache, helper, runDir };
}
