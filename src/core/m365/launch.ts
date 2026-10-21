/* eslint obsidianmd/prefer-window-timers: off -- Pure core runs in Node (tests, the helper process) where there is no window. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowserNode, safeAbsolutePath } from '../runtimes/browserTools';
import {
  actionSchema,
  describeAction,
  executeAction,
  summarizeTarget,
  type Action,
  type ActionCard,
} from './actions';
import { accessToken } from './auth';
import type { Fetch } from './graph';

export const M365_SERVER = 'm365';

/** Runtimes that can load exactly this one extra server for one run (same plumbing as the browser). */
const M365_RUNTIMES = ['claude-code', 'opencode', 'hermes'];

export interface M365Launch {
  node: string;
  helper: string;
  tokenFile: string;
  outbox: string;
}

export function m365UnavailableReason(
  runtime: string,
  connected: boolean,
): string {
  if (runtime === 'codex')
    return 'Codex can read the whole computer, including the folder that keeps the Microsoft sign-in, and starts tools outside its sandbox; Microsoft 365 is refused for it.';
  if (!M365_RUNTIMES.includes(runtime))
    return 'This runtime cannot load exactly Mesa’s Microsoft 365 tools, so they are refused.';
  if (!connected)
    return 'Connect Microsoft 365 first (Settings → Mesa → Connectors).';
  return '';
}

export const M365_WARNING =
  'This agent can read your mail, calendar and OneDrive files. Their text is untrusted: a bad email could try to trick the agent. Sending, replying, forwarding, deleting, answering invitations, sharing and writing files each need your Approve card. Do not combine it with Run commands: Allow freely.';

/** The MCP server every runtime gets for a Microsoft 365 run. */
export function m365ServerCommand(launch: M365Launch): {
  command: string;
  args: string[];
} {
  if (!Object.values(launch).every(safeAbsolutePath))
    throw Error('Unsafe Microsoft 365 launch paths.');
  return {
    command: launch.node,
    args: [
      launch.helper,
      '--agenthq-m365',
      '--token-file',
      launch.tokenFile,
      '--outbox',
      launch.outbox,
    ],
  };
}

/**
 * Watches a run's outbox. For each request it validates the request, shows the owner a card (built here, from the
 * request itself) and runs the action with the plugin's own token only if they approve.
 */
export function watchOutbox(
  outbox: string,
  ask: (card: ActionCard) => Promise<boolean>,
  options: { token?: () => Promise<string>; f: Fetch; everyMs?: number },
): () => void {
  const token = options.token ?? (() => accessToken({ f: options.f }));
  const seen = new Set<string>();
  // Written to a temporary name and renamed, so a reader never sees half a result.
  const answer = async (id: string, value: unknown) => {
    const temporary = join(outbox, `${id}.result.tmp`);
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, join(outbox, `${id}.result.json`));
  };
  const handle = async (id: string, file: string) => {
    try {
      const parsed = actionSchema.safeParse(
        JSON.parse(await readFile(file, 'utf8')),
      );
      if (!parsed.success) {
        await answer(id, { error: 'The request was not valid.' });
        return;
      }
      const action: Action = parsed.data;
      const access = await token();
      const card = describeAction(
        action,
        await summarizeTarget(action, access, options.f),
      );
      if (!(await ask(card))) {
        await answer(id, { rejected: true });
        return;
      }
      await answer(id, {
        ok: await executeAction(action, await token(), options.f),
      });
    } catch (error) {
      await answer(id, {
        error: error instanceof Error ? error.message : 'The action failed.',
      }).catch(() => {});
    }
  };
  const timer = setInterval(() => {
    void readdir(outbox)
      .then((names) => {
        for (const name of names) {
          const id = name.endsWith('.intent.json')
            ? name.slice(0, -'.intent.json'.length)
            : '';
          if (id && !seen.has(id)) {
            seen.add(id);
            void handle(id, join(outbox, name));
          }
        }
      })
      .catch(() => {});
  }, options.everyMs ?? 400);
  return () => clearInterval(timer);
}

export interface PreparedM365 {
  launch: M365Launch;
  /** Stops watching and removes the run's folder, with the token file in it. */
  stop(): void;
}

/** Everything one run needs: a private folder, a short-lived token file, the outbox and its watcher. */
export async function prepareM365Run(
  helper: string,
  ask: (card: ActionCard) => Promise<boolean>,
  options: { token?: () => Promise<string>; f: Fetch },
): Promise<PreparedM365> {
  const node = await findBrowserNode();
  if (!node)
    throw Error('Install Node.js to use Microsoft 365 (https://nodejs.org).');
  const token = options.token ?? (() => accessToken({ f: options.f }));
  const access = await token();
  const dir = mkdtempSync(join(tmpdir(), 'agenthq-m365-'));
  try {
    const tokenFile = join(dir, 'token.json');
    writeFileSync(tokenFile, JSON.stringify({ accessToken: access }), {
      mode: 0o600,
    });
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox);
    const stopWatching = watchOutbox(outbox, ask, { ...options, token });
    return {
      launch: { node: node.node, helper, tokenFile, outbox },
      stop: () => {
        stopWatching();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
