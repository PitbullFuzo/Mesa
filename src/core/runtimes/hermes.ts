import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32, posix } from 'node:path';
import { AcpRuntime } from './acp';
import { record } from './acpPolicy';
import type { Executable } from './detect';
interface HermesDetection {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}
export async function findHermesPython(
  options: HermesDetection = {},
): Promise<Executable | undefined> {
  const platform = options.platform ?? process.platform,
    env = options.env ?? process.env,
    windows = platform === 'win32',
    path = windows ? win32 : posix;
  const exists =
    options.exists ??
    (async (file: string) => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    });
  const home = (windows ? env.USERPROFILE : env.HOME) ?? '';
  const directories = (
    Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  )
    .split(windows ? ';' : ':')
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter(Boolean);
  const known = windows
    ? [
        path.join(env.LOCALAPPDATA ?? '', 'hermes', 'bin'),
        path.join(
          env.LOCALAPPDATA ?? '',
          'hermes',
          'hermes-agent',
          'venv',
          'Scripts',
        ),
      ]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.hermes', 'hermes-agent', 'venv', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
  for (const directory of [...directories, ...known])
    for (const name of windows ? ['hermes.exe', 'hermes.cmd'] : ['hermes']) {
      const launcher = path.join(directory, name);
      if (!(await exists(launcher))) continue;
      const interpreters = windows
        ? [
            path.join(directory, 'python.exe'),
            path.join(
              env.LOCALAPPDATA ?? '',
              'hermes',
              'hermes-agent',
              'venv',
              'Scripts',
              'python.exe',
            ),
          ]
        : [
            path.join(directory, 'python'),
            path.join(directory, 'python3'),
            path.join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'python'),
          ];
      if (!windows && !options.exists)
        try {
          const first = (await readFile(launcher, 'utf8')).split('\n')[0] ?? '';
          const match = first.match(/^#!(\/[^\s]+)\s*$/);
          if (match) interpreters.unshift(match[1]!);
        } catch {
          /* Native executable or unreadable script. */
        }
      for (const interpreter of interpreters)
        if (await exists(interpreter))
          return { file: interpreter, args: [], path: launcher };
    }
  return undefined;
}
export function createHermesRuntime(bootstrap: string, browserHelper?: string) {
  return new AcpRuntime({
    id: 'hermes',
    displayName: 'Hermes',
    policy: 'files-v1',
    browserPolicy: 'playwright-v1',
    browserHelper,
    env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    resolve: async () => {
      const executable = await findHermesPython();
      if (!executable) return;
      const result = await promisify(execFile)(
        executable.file,
        [bootstrap, '--check'],
        {
          shell: false,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      const check = record(JSON.parse(result.stdout.trim()) as unknown);
      if (
        check.policy !== 'files-v1' ||
        check.editApproval !== 'ask' ||
        check.browser !== 'playwright-v1' ||
        check.m365 !== 'm365-v1' ||
        // The start-up check runs without Allow freely: commands must be disabled then.
        check.commands !== false
      )
        throw Error('Unsafe Hermes bootstrap');
      return {
        ...executable,
        args: [bootstrap],
        version: typeof check.version === 'string' ? check.version : 'unknown',
      };
    },
  });
}
