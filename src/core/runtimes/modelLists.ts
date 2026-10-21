import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  parseCodexModels,
  parseOpenCodeModels,
  type ModelChoice,
} from '../models';
import { findCodex } from './codex';
import { findOpenCode, openCodeEnvironment } from './openCode';
import type { RunRequest } from './types';

const cache = new Map<string, Promise<ModelChoice[]>>();

/**
 * Model list for one runtime, read without any model call. Successful lists are cached for the
 * session; failures are not, so a later attempt can succeed. Claude Code uses its fixed aliases.
 */
export function runtimeModelList(runtime: string): Promise<ModelChoice[]> {
  if (runtime !== 'opencode' && runtime !== 'codex') return Promise.resolve([]);
  let pending = cache.get(runtime);
  if (!pending) {
    pending = (runtime === 'opencode' ? listOpenCode() : listCodex()).catch(
      (error: unknown) => {
        cache.delete(runtime);
        throw error;
      },
    );
    cache.set(runtime, pending);
  }
  return pending;
}

/** The command that lists models: the bare `models` subcommand. The runtime's `acp --pure` would start the ACP server instead. */
export function openCodeModelsCommand(file: string): {
  file: string;
  args: string[];
} {
  return { file, args: ['models'] };
}

async function listOpenCode(): Promise<ModelChoice[]> {
  const executable = await findOpenCode();
  if (!executable) return [];
  // The same isolated state directory as the OpenCode runtime, so the owner's own config is not read.
  const state = join(
    process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
    'Mesa',
    'opencode',
  );
  await mkdir(state, { recursive: true });
  const env = openCodeEnvironment(
    { permission: 'read-only', webAccess: false } as RunRequest,
    state,
  );
  const command = openCodeModelsCommand(executable.file);
  const { stdout } = await promisify(execFile)(command.file, command.args, {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseOpenCodeModels(stdout);
}

async function listCodex(): Promise<ModelChoice[]> {
  const executable = await findCodex();
  if (!executable) return [];
  const { stdout } = await promisify(execFile)(
    executable.file,
    [...executable.args, 'debug', 'models'],
    {
      cwd: tmpdir(),
      shell: false,
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return parseCodexModels(stdout);
}
