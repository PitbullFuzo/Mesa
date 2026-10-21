import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { parseObiProposals } from '../src/core/obi';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import { buildCodexArgs } from '../src/core/runtimes/codex';
import { findHermesPython } from '../src/core/runtimes/hermes';
import {
  openCodeEnvironment,
  openCodePolicyProblem,
} from '../src/core/runtimes/openCode';
import type { RunRequest, RuntimeAdapter } from '../src/core/runtimes/types';

const launch = {
  node: 'C:/node/node.exe',
  helper: 'C:/vault/plugin/m365_mcp.cjs',
  tokenFile: 'C:/tmp/run/token.json',
  outbox: 'C:/tmp/run/outbox',
};
const claude: RunRequest = {
  prompt: 'p',
  systemPrompt: 's',
  cwd: 'C:/vault/Obi-I/Work/coder',
  sessionId: '11111111-1111-4111-8111-111111111111',
  resume: false,
  permission: 'read-only',
  protectedPaths: ['C:/vault/.obsidian'],
};

describe('Claude Code gets the helper only when the run has it', () => {
  const config = (args: string[]) =>
    JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as {
      mcpServers: Record<string, { args: string[] }>;
    };
  it('adds exactly the m365 server and allows only its tools', () => {
    const args = buildRuntimeArgs(
      { ...claude, m365Launch: launch },
      'C:/s.txt',
    );
    expect(Object.keys(config(args).mcpServers)).toEqual(['m365']);
    expect(args.some((a) => a.includes('mcp__m365__*'))).toBe(true);
    expect(args).not.toContain('mcp__*');
    expect(args).toContain('--strict-mcp-config');
  });
  it('without it there is no server and every MCP tool stays denied', () => {
    const args = buildRuntimeArgs(claude, 'C:/s.txt');
    expect(config(args).mcpServers).toEqual({});
    expect(args).toContain('mcp__*');
    expect(args.some((a) => a.includes('m365'))).toBe(false);
  });
});

describe('OpenCode', () => {
  it('loads exactly the helper and allows only its tools; the policy check accepts exactly that', () => {
    const env = openCodeEnvironment({ ...claude, m365Launch: launch }, 'C:/s');
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as {
      mcp: Record<string, { command: string[] }>;
    };
    expect(Object.keys(config.mcp)).toEqual(['m365']);
    expect(JSON.parse(env.OPENCODE_PERMISSION!)).toMatchObject({
      '*': 'deny',
      'm365_*': 'allow',
    });
    const effective = (mcp: unknown) =>
      JSON.stringify({
        formatter: false,
        lsp: false,
        snapshot: false,
        mcp,
        instructions: [],
        agent: {
          agenthq: {
            mode: 'primary',
            permission: JSON.parse(env.OPENCODE_PERMISSION!) as unknown,
          },
        },
      });
    expect(openCodePolicyProblem(effective(config.mcp), env)).toBeUndefined();
    expect(
      openCodePolicyProblem(effective({ ...config.mcp, github: {} }), env),
    ).toContain('differs');
    const plain = openCodeEnvironment(claude, 'C:/s');
    expect(JSON.parse(plain.OPENCODE_PERMISSION!)).not.toHaveProperty('m365_*');
  });
});

describe('Codex', () => {
  it('is refused: it reads the whole computer, including the sign-in folder', () => {
    expect(() =>
      buildCodexArgs({
        ...claude,
        wholeComputerReadConfirmed: true,
        m365Launch: launch,
      }),
    ).toThrow(/whole computer/);
  });
});

describe('Obi', () => {
  it('cannot turn Microsoft 365 on', () => {
    const reply =
      '```agenthq-admin\n{"actions":[{"type":"updateAgent","id":"coder","canUseM365":true}]}\n```';
    const { proposals, problems } = parseObiProposals(reply, {
      agents: [],
      groups: [],
    });
    expect(proposals).toEqual([]);
    expect(problems.join(' ')).toContain('Obi cannot enable Microsoft 365');
  });
});

const hermes = await findHermesPython();
describe.skipIf(!hermes)('Hermes shim', () => {
  it('accepts the browser and Microsoft 365 servers only, by name, and allows their tools', async () => {
    const code = [
      'import hermes_bootstrap',
      'import runpy,sys,asyncio,types',
      "sys.argv=['t','--check']",
      `n=runpy.run_path(${JSON.stringify(resolve('src/core/runtimes/hermes_acp.py'))})`,
      "d=n['dispatch']",
      "d.__globals__['original_dispatch']=lambda *a,**k:'ran'",
      "assert d('mcp__m365__mail_search',{})=='ran'",
      "assert d('mcp__playwright__browser_navigate',{})=='ran'",
      "assert 'disabled' in d('mcp__github__x',{})",
      "server=lambda name:types.SimpleNamespace(name=name,command='node',args=[],env=[])",
      "async def register(servers):\n try:\n  await n['register_session_mcp_servers'](None,types.SimpleNamespace(),servers)\n except RuntimeError as error:\n  return str(error)\n except Exception:\n  return 'accepted'\n return 'accepted'",
      "for bad in ([server('github')],[server('m365'),server('github')],[server('m365'),server('m365')]):\n assert 'only its own' in asyncio.run(register(bad)), bad",
      "print('M365_POLICY_PASS')",
    ].join('\n');
    const result = await promisify(execFile)(hermes!.file, ['-c', code], {
      shell: false,
      windowsHide: true,
      timeout: 30000,
    });
    expect(result.stdout).toContain('M365_POLICY_PASS');
    const check = await promisify(execFile)(
      hermes!.file,
      [resolve('src/core/runtimes/hermes_acp.py'), '--check'],
      { shell: false, windowsHide: true, timeout: 30000 },
    );
    expect(check.stdout).toContain('"m365": "m365-v1"');
  }, 45000);
});

/** A runtime that records its request and lets the test play the agent asking for a Microsoft action. */
async function service(options: {
  runtime: string;
  canUseM365: boolean;
  connected: boolean;
}) {
  const store = new MemoryStore('Obi-I');
  const id = await store.createAgent('Mailer');
  await store.patchAgent(id, {
    runtime: options.runtime,
    canUseM365: options.canUseM365,
  });
  const requests: RunRequest[] = [];
  let release: () => void = () => {};
  const stopRun = vi.fn();
  let ask!: (card: { title: string; text: string }) => Promise<boolean>;
  const prepare = vi.fn(async (_helper: string, asker: typeof ask) => {
    ask = asker;
    return { launch, stop: stopRun };
  });
  const adapter: RuntimeAdapter = {
    id: options.runtime as RuntimeAdapter['id'],
    displayName: 'R',
    detect: async () => ({ available: true }),
    start: (request, onEvent) => {
      requests.push(request);
      release = () =>
        onEvent({ type: 'done', text: 'ok', isError: false, costUsd: 0 });
      return { stop: async () => {} };
    },
  };
  const chat = new ChatService({
    store,
    adapters: [adapter],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    memoryDelayMs: 60_000,
    m365: {
      helper: 'C:/vault/plugin/m365_mcp.cjs',
      connected: () => options.connected,
      fetch: fetch,
      prepare: prepare,
    },
  });
  await chat.initialize();
  return {
    chat,
    id,
    requests,
    prepare,
    stopRun,
    ask: (card: { title: string; text: string }) => ask(card),
    finish: () => release(),
  };
}
const cards = (s: Awaited<ReturnType<typeof service>>) =>
  s.chat.getSnapshot().agents[s.id]?.commandApprovals ?? [];

describe('the chat gives Microsoft 365 only to agents that have it, and shows a card for each action', () => {
  it('an agent with it, connected, gets the launch; the run folder is cleaned up afterwards', async () => {
    const s = await service({
      runtime: 'claude-code',
      canUseM365: true,
      connected: true,
    });
    const done = s.chat.send(s.id, 'check my mail');
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    expect(s.requests[0]!.m365Launch).toEqual(launch);
    expect(s.stopRun).not.toHaveBeenCalled();
    s.finish();
    await done;
    expect(s.stopRun).toHaveBeenCalledOnce();
  });
  it.each([
    [
      'without the switch',
      { runtime: 'claude-code', canUseM365: false, connected: true },
    ],
    [
      'when not connected',
      { runtime: 'claude-code', canUseM365: true, connected: false },
    ],
    ['for Codex', { runtime: 'codex', canUseM365: true, connected: true }],
  ])(
    'an agent %s sees nothing: no launch, nothing prepared',
    async (_name, options) => {
      const s = await service(options);
      const done = s.chat.send(s.id, 'go');
      await vi.waitFor(() => expect(s.requests).toHaveLength(1));
      expect(s.requests[0]!.m365Launch).toBeUndefined();
      expect(s.prepare).not.toHaveBeenCalled();
      s.finish();
      await done.catch(() => {});
    },
  );
  it('a send shows a card with the title and full text; Approve answers true, Reject false, nothing is remembered', async () => {
    const s = await service({
      runtime: 'opencode',
      canUseM365: true,
      connected: true,
    });
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    const text = 'To: a@example.com\n\nHello';
    const first = s.ask({ title: 'Send an email', text });
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    expect(cards(s)[0]).toMatchObject({
      title: 'Send an email',
      command: text,
    });
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, true);
    expect(await first).toBe(true);
    const second = s.ask({ title: 'Send an email', text });
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    expect(await Promise.race([second, Promise.resolve('waiting')])).toBe(
      'waiting',
    );
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, false);
    expect(await second).toBe(false);
    s.finish();
    await done;
  });
  it('a stopped run rejects its waiting card', async () => {
    const s = await service({
      runtime: 'opencode',
      canUseM365: true,
      connected: true,
    });
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    const waiting = s.ask({ title: 'Delete an email', text: 'Message: x' });
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    await s.chat.stop(s.id);
    expect(await waiting).toBe(false);
    await done.catch(() => {});
  });
  it('a scheduled run also puts an Inbox item up while a card waits', async () => {
    const s = await service({
      runtime: 'opencode',
      canUseM365: true,
      connected: true,
    });
    const done = s.chat.send(s.id, 'go', undefined, true);
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    const waiting = s.ask({ title: 'Send an email', text: 'x' });
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    expect(
      (s.chat.getSnapshot().inbox ?? []).filter(
        (i) => i.kind === 'command-approval',
      ),
    ).toHaveLength(1);
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, false);
    await waiting;
    s.finish();
    await done;
  });
});
