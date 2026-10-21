import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBrowserNode } from './runtimes/browserTools';
import type { RuntimeAdapter, RuntimeStatus } from './runtimes/types';
import { VERIFIED_VERSIONS } from './runtimes/versionPolicy';

const run = promisify(execFile);

export interface ToolCheck {
  id: string;
  label: string;
  /** ready; missing (not installed); unavailable (found, but not ready for another reason); wrong-version (blocked by policy). */
  status: 'ready' | 'missing' | 'unavailable' | 'wrong-version';
  /** The version found, or why the tool is not ready. */
  detail: string;
  /** One line on how to install it, with a link where one is known. */
  install: string;
}

export const INSTALL_HINTS: Record<string, string> = {
  'claude-code':
    'Install Claude Code from https://code.claude.com/docs/en/setup, then sign in with your Claude plan or an API key.',
  codex: `Install the Codex CLI (version ${VERIFIED_VERSIONS.codex} or newer), then run codex login: https://github.com/openai/codex`,
  opencode: `Install OpenCode (version ${VERIFIED_VERSIONS.opencode} or newer) from https://opencode.ai, then sign in.`,
  hermes: 'Install Hermes, then follow the Hermes section of the README.',
  node: 'Install Node.js from https://nodejs.org (needed only for browser control).',
};

/**
 * The Node.js version found by the same finder the browser tools use, or undefined when there is none.
 * No shell is used.
 */
export async function findNodeVersion(): Promise<string | undefined> {
  const found = await findBrowserNode();
  if (!found) return undefined;
  try {
    const { stdout } = await run(found.node, ['--version']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function runtimeCheck(
  id: string,
  label: string,
  status: RuntimeStatus,
): ToolCheck {
  const install = INSTALL_HINTS[id] ?? '';
  if (status.available)
    return {
      id,
      label,
      status: 'ready',
      // A newer version's note ("checked by Mesa, not yet verified") is shown with its version.
      detail: [status.version ?? 'found', status.hint]
        .filter(Boolean)
        .join('; '),
      install,
    };
  // Blocked by the version policy: the hint names this tool and the version it needs.
  if (status.blocked)
    return {
      id,
      label,
      status: 'wrong-version',
      detail:
        `version ${status.version ?? 'unknown'}; ${status.hint ?? ''}`.trim(),
      install,
    };
  // Found, but not ready for another reason (for example not signed in): not a version problem.
  if (status.version !== undefined)
    return {
      id,
      label,
      status: 'unavailable',
      detail: status.hint ?? 'found, but not ready',
      install,
    };
  return { id, label, status: 'missing', detail: 'not found', install };
}

/**
 * The setup check: every AI tool's own detection, plus Node.js. Fake test runtimes are skipped.
 * This only reads versions; it never runs a model.
 */
export async function checkSetup(
  adapters: RuntimeAdapter[],
  findNode: () => Promise<string | undefined> = findNodeVersion,
): Promise<ToolCheck[]> {
  const checks: ToolCheck[] = [];
  for (const adapter of adapters) {
    if (adapter.id === 'fake') continue;
    const status = await adapter
      .detect()
      .catch((): RuntimeStatus => ({ available: false }));
    checks.push(runtimeCheck(adapter.id, adapter.displayName, status));
  }
  const node = await findNode();
  checks.push({
    id: 'node',
    label: 'Node.js',
    status: node ? 'ready' : 'missing',
    detail: node ?? 'not found',
    install: INSTALL_HINTS.node ?? '',
  });
  return checks;
}

/** One readable line per tool, for the notice, the tour and Obi. */
export function setupLine(check: ToolCheck): string {
  const state =
    check.status === 'ready'
      ? `ready (${check.detail})`
      : check.status === 'missing'
        ? 'missing'
        : check.status === 'unavailable'
          ? `found but not ready (${check.detail})`
          : `wrong version (${check.detail})`;
  const install = check.status === 'ready' ? '' : ` — ${check.install}`;
  return `${check.label}: ${state}${install}`;
}
