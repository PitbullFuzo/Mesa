import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface Executable {
  version?: string;
  path: string;
  file: string;
  args: string[];
}
export interface DetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runtimePathOverride?: string;
}

export async function findRuntimeExecutable(
  options: DetectionOptions = {},
): Promise<Executable | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const home = (windows ? env.USERPROFILE : env.HOME) ?? '';
  const names = windows ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const pathValue =
    Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ??
    '';
  const pathDirs = pathValue
    .split(windows ? ';' : ':')
    .map((dir) =>
      windows && dir.startsWith('"') && dir.endsWith('"')
        ? dir.slice(1, -1)
        : dir,
    )
    .filter((dir) => dir && isAbsolute(dir));
  const candidates = options.runtimePathOverride?.trim()
    ? [options.runtimePathOverride.trim()]
    : [
        ...pathDirs.flatMap((dir) => names.map((name) => join(dir, name))),
        ...(home ? [join(home, '.local', 'bin', names[0]!)] : []),
        ...(windows
          ? env.APPDATA
            ? [join(env.APPDATA, 'npm', 'claude.cmd')]
            : []
          : [
              '/opt/homebrew/bin/claude',
              '/usr/local/bin/claude',
              ...(home ? [join(home, '.npm-global', 'bin', 'claude')] : []),
            ]),
      ];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, windows ? constants.F_OK : constants.X_OK);
      if (windows && /\.(cmd|bat)$/i.test(path)) {
        // Run npm's known JS entry directly: never evaluate a command shim.
        const entry = join(
          dirname(path),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js',
        );
        if (!(await stat(entry)).isFile()) continue;
        return { path, file: process.execPath, args: [entry] };
      }
      if (windows && !/\.exe$/i.test(path)) continue;
      return { path, file: path, args: [] };
    } catch {
      /* Try the next candidate. Overrides never fall back. */
    }
  }
  return undefined;
}
