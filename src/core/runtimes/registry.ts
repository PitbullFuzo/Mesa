import { PLUGIN_ID } from '../appData';
/* eslint obsidianmd/hardcoded-config-path: off -- Desktop runtime protects both the default directory and the supplied host configDir. */
import { posix, win32 } from 'node:path';
import { vaultRoot } from '../paths';
import { protectedAgentHqPaths } from '../protectedFolders';
import { ClaudeCodeRuntime } from './claudeCode';
import { FakeRuntime } from './fake';
import { createHermesRuntime } from './hermes';
import { CodexRuntime } from './codex';
import { createOpenCodeRuntime } from './openCode';
import type { RuntimeAdapter } from './types';
import type { SelfTestMemory, SelfTestRecord } from './selfTest';

export interface RuntimeRegistryOptions {
  runtimePathOverride?: string;
  vaultBasePath: string;
  managedRoot: string;
  configDir?: string;
  developerMode: boolean;
  /** Remembered self-test results; the same object the plugin saves, so each newer version is checked once. */
  selfTests?: SelfTestMemory;
  rememberSelfTest?: (key: string, record: SelfTestRecord) => void;
}

/** The absolute folders and notes no runtime may edit: the same list workdir uses, plus the config folders. */
export function runtimeProtectedPaths(
  options: RuntimeRegistryOptions,
): string[] {
  const path = /^[a-z]:[\\/]/i.test(options.vaultBasePath) ? win32 : posix;
  const root = vaultRoot(options.managedRoot, '.obsidian');
  return [
    path.join(options.vaultBasePath, '.obsidian'),
    ...(options.configDir
      ? [path.join(options.vaultBasePath, options.configDir)]
      : []),
    ...protectedAgentHqPaths(root).map((entry) =>
      path.join(options.vaultBasePath, entry),
    ),
  ];
}

export function createRuntimeAdapters(
  options: RuntimeRegistryOptions,
): RuntimeAdapter[] {
  const path = /^[a-z]:[\\/]/i.test(options.vaultBasePath) ? win32 : posix;
  if (!path.isAbsolute(options.vaultBasePath))
    throw new Error('The vault base path must be absolute.');
  const browserHelper = path.join(
    options.vaultBasePath,
    options.configDir ?? '.obsidian',
    'plugins',
    PLUGIN_ID,
    'browser_mcp.cjs',
  );
  const adapters: RuntimeAdapter[] = [
    new ClaudeCodeRuntime({
      runtimePathOverride: options.runtimePathOverride,
      protectedPaths: runtimeProtectedPaths(options),
      browserHelper,
    }),
    createHermesRuntime(
      path.join(
        options.vaultBasePath,
        options.configDir ?? '.obsidian',
        'plugins',
        PLUGIN_ID,
        'hermes_acp.py',
      ),
      browserHelper,
    ),
    createOpenCodeRuntime({
      browserHelper,
      selfTests: options.selfTests ?? {},
      rememberSelfTest: options.rememberSelfTest,
    }),
    new CodexRuntime({
      browserHelper,
      selfTests: options.selfTests ?? {},
      rememberSelfTest: options.rememberSelfTest ?? (() => undefined),
    }),
  ];
  if (options.developerMode) adapters.push(new FakeRuntime());
  return adapters;
}
