import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { AcpRuntime } from '../src/core/runtimes/acp';
import { findHermesPython } from '../src/core/runtimes/hermes';
import { commandsAsk } from '../src/core/runtimes/ids';
import { openCodeEnvironment } from '../src/core/runtimes/openCode';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '../src/core/runtimes/types';

describe('which runtimes can ask before every command', () => {
  it('only OpenCode and Hermes; Claude Code and Codex keep Off and Allow freely', () => {
    expect(commandsAsk('opencode')).toBe(true);
    expect(commandsAsk('hermes')).toBe(true);
    expect(commandsAsk('claude-code')).toBe(false);
    expect(commandsAsk('codex')).toBe(false);
  });
});

const base: RunRequest = {
  prompt: 'p',
  systemPrompt: 's',
  cwd: 'C:/Vault/Work/a',
  extraDirs: [],
  protectedPaths: ['C:/Vault/Agents'],
  permission: 'read-only',
  sessionId: '22222222-2222-4222-8222-222222222222',
  resume: false,
};

describe('OpenCode bash permission', () => {
  const bash = (request: Partial<RunRequest>) =>
    (
      JSON.parse(
        openCodeEnvironment({ ...base, ...request }, 'C:/s')
          .OPENCODE_PERMISSION!,
      ) as { bash: string }
    ).bash;
  it('is ask only for an asking run, allow for Allow freely, deny otherwise', () => {
    expect(bash({})).toBe('deny');
    expect(bash({ runCommands: true })).toBe('allow');
    expect(bash({ askCommand: async () => true })).toBe('ask');
  });
});

/** A scripted ACP runtime that asks permission to run one command and reports the option it was answered with. */
function permissionRun(request: RunRequest) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const answers: unknown[] = [];
  const reply = (value: unknown) =>
    child.stdout.write(JSON.stringify(value) + '\n');
  let buffer = '';
  let promptId: unknown;
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, n)) as Record<string, unknown>;
      buffer = buffer.slice(n + 1);
      if (!m.method) {
        answers.push(m.result);
        reply({
          jsonrpc: '2.0',
          id: promptId,
          result: { stopReason: 'end_turn' },
        });
        continue;
      }
      if (m.method === 'session/prompt') {
        promptId = m.id;
        reply({
          jsonrpc: '2.0',
          id: 99,
          method: 'session/request_permission',
          params: {
            sessionId: 's1',
            toolCall: {
              toolCallId: 'c1',
              kind: 'execute',
              title: 'echo hi',
              rawInput: { command: 'echo hi' },
            },
            options: [
              { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
              { optionId: 'always', kind: 'allow_always', name: 'Always' },
              { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
            ],
          },
        });
        continue;
      }
      const result: Record<string, unknown> =
        m.method === 'initialize'
          ? {
              protocolVersion: 1,
              agentInfo: { name: 'OpenCode', version: '1.19.1' },
            }
          : m.method === 'session/new'
            ? { sessionId: 's1' }
            : {};
      reply({ jsonrpc: '2.0', id: m.id, result });
    }
  });
  const runtime = new AcpRuntime(
    {
      id: 'opencode',
      displayName: 'OpenCode',
      agentInfo: { name: 'OpenCode', version: '1.19.1' },
      mode: 'agenthq',
      resolve: async () => ({ file: 'o.exe', args: [], path: 'o.exe' }),
    },
    {
      spawn: vi.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      killTree: async () => {
        child.emit('close', null);
      },
      canonical: async (p) => p,
    },
  );
  const events: RunEvent[] = [];
  runtime.start(request, (e) => events.push(e));
  return { answers, events };
}

describe('ACP command permission requests', () => {
  it.each([
    [true, 'once'],
    [false, 'reject'],
  ])(
    'asks the owner (approved: %s) and answers %s, never "always"',
    async (approved, option) => {
      const asked = vi.fn(async () => approved);
      const { answers, events } = permissionRun({ ...base, askCommand: asked });
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(asked).toHaveBeenCalledWith({
        command: 'echo hi',
        cwd: base.cwd,
      });
      expect(answers).toEqual([
        { outcome: { outcome: 'selected', optionId: option } },
      ]);
    },
  );
  it('rejects a command when no card can be shown, and when asking fails', async () => {
    for (const request of [
      base,
      {
        ...base,
        askCommand: async () => {
          throw Error('card failed');
        },
      },
    ]) {
      const { answers, events } = permissionRun(request);
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
      expect(answers).toEqual([
        { outcome: { outcome: 'selected', optionId: 'reject' } },
      ]);
    }
  });
});

/** An adapter whose run asks to run one command and reports the owner's answer. */
function askingAdapter() {
  const answers: boolean[] = [];
  const requests: RunRequest[] = [];
  const adapter: RuntimeAdapter = {
    id: 'opencode',
    displayName: 'OpenCode',
    detect: async () => ({ available: true }),
    start: (request, onEvent) => {
      requests.push(request);
      const finish = () =>
        onEvent({ type: 'done', text: 'ok', isError: false, costUsd: 0 });
      if (request.askCommand)
        void request
          .askCommand({ command: 'dir C:/x', cwd: 'C:/work' })
          .then((ok) => {
            answers.push(ok);
            finish();
          });
      else finish();
      return { stop: async () => {} };
    },
  };
  return { adapter, answers, requests };
}

async function service(runtime: string, setting: 'ask' | 'off') {
  const store = new MemoryStore('Mesa');
  const id = await store.createAgent('Runner');
  await store.patchAgent(id, { runtime, runCommands: setting });
  const { adapter, answers, requests } = askingAdapter();
  const chat = new ChatService({
    store,
    adapters: [{ ...adapter, id: runtime as RuntimeAdapter['id'] }],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    memoryDelayMs: 60_000,
  });
  await chat.initialize();
  return { chat, id, answers, requests };
}
const cards = (s: Awaited<ReturnType<typeof service>>) =>
  s.chat.getSnapshot().agents[s.id]?.commandApprovals ?? [];

describe('Ask me each time in the chat', () => {
  it('waits behind a card with the full command and folder; Approve lets it run', async () => {
    const s = await service('opencode', 'ask');
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    expect(cards(s)[0]).toMatchObject({ command: 'dir C:/x', cwd: 'C:/work' });
    expect(s.answers).toEqual([]);
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, true);
    await done;
    expect(s.answers).toEqual([true]);
    expect(cards(s)).toEqual([]);
    expect(s.requests[0]!.runCommands).toBe(false);
  });
  it('Reject tells the run and a second answer is ignored', async () => {
    const s = await service('opencode', 'ask');
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    const id = cards(s)[0]!.id;
    s.chat.resolveCommand(s.id, id, false);
    s.chat.resolveCommand(s.id, id, true);
    await done;
    expect(s.answers).toEqual([false]);
  });
  it('a stopped run rejects its waiting card', async () => {
    const s = await service('opencode', 'ask');
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    await s.chat.stop(s.id);
    await done.catch(() => {});
    expect(cards(s)).toEqual([]);
    expect(s.answers.every((ok) => ok === false)).toBe(true);
  });
  it('a scheduled or looping run adds an Inbox item that clears when answered', async () => {
    const s = await service('opencode', 'ask');
    const done = s.chat.send(s.id, 'go', undefined, true);
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    const open = () =>
      (s.chat.getSnapshot().inbox ?? []).filter(
        (item) => item.kind === 'command-approval' && !item.resolved,
      );
    expect(open()).toHaveLength(1);
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, false);
    await done;
    await vi.waitFor(() => expect(open()).toHaveLength(0));
  });
  it('a chat you are watching adds no Inbox item', async () => {
    const s = await service('opencode', 'ask');
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(cards(s)).toHaveLength(1));
    expect(s.chat.getSnapshot().inbox ?? []).toEqual([]);
    s.chat.resolveCommand(s.id, cards(s)[0]!.id, true);
    await done;
  });
  it('a runtime that cannot ask never gets a card or a command, even if the note says ask', async () => {
    for (const runtime of ['claude-code', 'codex']) {
      const s = await service(runtime, 'ask');
      await s.chat.send(s.id, 'go');
      expect(s.requests[0]!.askCommand).toBeUndefined();
      expect(s.requests[0]!.runCommands).toBe(false);
    }
  });
});

const hermes = await findHermesPython();
describe.skipIf(!hermes)('Hermes shim asks before every command tool', () => {
  const run = async (callback: string, mode: string) => {
    const code = [
      'import hermes_bootstrap',
      'import runpy,sys',
      "sys.argv=['t','--check']",
      `n=runpy.run_path(${JSON.stringify(resolve('src/core/runtimes/hermes_acp.py'))})`,
      'from tools import terminal_tool',
      callback,
      "d=n['dispatch']",
      "d.__globals__['original_dispatch']=lambda *a,**k:'RAN'",
      "print(d('terminal',{'command':'echo hi'}), d('execute_code',{'code':'print(1)'}), d('web_search',{}))",
    ].join('\n');
    const result = await promisify(execFile)(hermes!.file, ['-c', code], {
      shell: false,
      windowsHide: true,
      timeout: 120000,
      env: { ...process.env, AGENTHQ_RUN_COMMANDS: mode },
    });
    return result.stdout.trim().split(String.fromCharCode(10)).at(-1)!;
  };
  it('runs a command only when the owner answers allow-once', async () => {
    const out = await run(
      'terminal_tool.set_approval_callback(lambda c,d,**k:"once")',
      'ask',
    );
    expect(out).toBe('RAN RAN RAN');
  }, 300000);
  it.each(['deny', 'always', 'session'])(
    'refuses a command when the owner answers %s',
    async (answer) => {
      const out = await run(
        `terminal_tool.set_approval_callback(lambda c,d,**k:"${answer}")`,
        'ask',
      );
      expect(out.match(/not approved/g)).toHaveLength(2);
      expect(out.match(/RAN/g)).toHaveLength(1);
    },
    40000,
  );
  it('refuses with no callback, and Allow freely and Off are unchanged', async () => {
    const none = await run('terminal_tool.set_approval_callback(None)', 'ask');
    expect(none.match(/not approved/g)).toHaveLength(2);
    expect(await run('pass', 'true')).toBe('RAN RAN RAN');
    expect((await run('pass', 'false')).match(/disabled/g)).toHaveLength(2);
  }, 300000);
});
