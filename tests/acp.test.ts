import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import recordedPermissions from './fixtures/hermes-acp-permissions.json';
import recordedOpenCode from './fixtures/opencode-acp-permissions.json';
import { AcpRuntime } from '../src/core/runtimes/acp';
import { approveOpenCode } from '../src/core/runtimes/openCode';
import type { RunEvent, RunRequest } from '../src/core/runtimes/types';
vi.mock('../src/core/runtimes/browserTools', async (original) => ({
  ...(await original<typeof import('../src/core/runtimes/browserTools')>()),
  // No real Playwright install is needed to check what is sent to the runtime.
  browserLaunchFor: async (helper: string, runDir: string) => ({
    node: 'C:/node/node.exe',
    server: 'C:/tools/cli.js',
    browser: 'C:/pw/chrome.exe',
    cache: 'C:/pw',
    helper,
    runDir,
  }),
}));
const session = '11111111-1111-4111-8111-111111111111';
const req: RunRequest = {
  prompt: 'hello',
  systemPrompt: 'system',
  cwd: 'C:/Vault/Work/a',
  extraDirs: ['C:/Vault/Work'],
  protectedPaths: ['C:/Vault/Agents'],
  permission: 'edit',
  sessionId: '22222222-2222-4222-8222-222222222222',
  resume: false,
  model: 'openrouter:cheap',
};
function fixture(
  hold = false,
  policy = 'files-v1',
  killRace = false,
  native = false,
) {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const calls: Record<string, unknown>[] = [];
  const reply = (value: unknown) =>
    child.stdout.write(JSON.stringify(value) + '\n');
  let buffer = '';
  let promptId: unknown;
  const permissionIds = new Set<unknown>(
    native
      ? recordedOpenCode.frames
          .filter((m) => m.method === 'session/request_permission')
          .map((m) => m.id)
      : [],
  );
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, n)) as Record<string, unknown>;
      buffer = buffer.slice(n + 1);
      calls.push(m);
      if (!m.method) {
        if (native && permissionIds.delete(m.id) && permissionIds.size === 0) {
          // Synthetic nonzero cumulative usage supplements the recorded free cost.
          reply({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: session,
              update: {
                sessionUpdate: 'usage_update',
                cost: { amount: 3, currency: 'USD' },
              },
            },
          });
          reply({
            jsonrpc: '2.0',
            id: promptId,
            result: { stopReason: 'end_turn' },
          });
        }
        continue;
      }
      let result: unknown = {};
      if (m.method === 'initialize')
        result = native
          ? {
              protocolVersion: 1,
              agentInfo: { name: 'OpenCode', version: policy },
            }
          : {
              protocolVersion: 1,
              _meta: {
                agenthqPolicy: policy,
                agenthqBrowser: 'playwright-v1',
                agenthqM365: 'm365-v1',
              },
            };
      if (m.method === 'session/new') result = { sessionId: session };
      if (m.method === 'session/load') {
        reply({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: session,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'old replay' },
            },
          },
        });
      }
      if (m.method === 'session/prompt') {
        if (hold) continue;
        if (native) {
          promptId = m.id;
          for (const m of recordedOpenCode.frames) {
            const bytes = Buffer.from(
              JSON.stringify({
                ...m,
                params: { ...m.params, sessionId: session },
              }) + '\n',
            );
            for (let i = 0; i < bytes.length; i += 17)
              child.stdout.write(bytes.subarray(i, i + 17));
          }
          continue;
        }
        for (const text of ['Hi ', '世界'])
          reply({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: session,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
              },
            },
          });
        reply({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: session,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't1',
              title: 'read_file',
              rawInput: { path: 'a.txt' },
            },
          },
        });
        result = { stopReason: 'end_turn', _meta: { agenthqCostUsd: 0.001 } };
      }
      if (m.id !== undefined) reply({ jsonrpc: '2.0', id: m.id, result });
    }
  });
  const killTree = vi.fn(async () => {
    child.emit('close', null);
    if (killRace) throw Error('taskkill: descendant already exited');
  });
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const runtime = new AcpRuntime(
    {
      id: native ? 'opencode' : 'hermes',
      displayName: native ? 'OpenCode' : 'Hermes',
      resolve: async () => ({
        file: 'runtime.exe',
        args: [],
        path: 'runtime.exe',
      }),
      ...(native
        ? {
            agentInfo: { name: 'OpenCode', version: '1.19.1' },
            mode: 'agenthq',
            approvePermission: approveOpenCode,
            prepareEnv: async () => ({ AGENTHQ_TEST_ENV: 'native' }),
          }
        : {
            policy: 'files-v1',
            browserPolicy: 'playwright-v1',
            browserHelper: 'C:/vault/plugin/browser_mcp.cjs',
          }),
    },
    { spawn, killTree, canonical: async (p) => p },
  );
  return { child, calls, runtime, spawn, killTree };
}
it('uses pinned OpenCode mode, correlates streamed read paths, ignores replay and subtracts resumed session usage', async () => {
  const { runtime, calls, spawn } = fixture(false, '1.19.1', false, true);
  const events: RunEvent[] = [];
  runtime.start(
    {
      ...req,
      cwd: 'C:/Vault/Mesa/Work/s11opencode',
      extraDirs: ['C:/Vault/Mesa/Work'],
      protectedPaths: ['C:/Vault/Mesa/Agents'],
      resume: true,
      sessionId: session,
      previousCostUsd: 2,
    },
    (e) => events.push(e),
  );
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
  expect(
    calls.filter((c) => !c.method).map((c) => JSON.stringify(c.result)),
  ).toEqual([
    JSON.stringify({ outcome: { outcome: 'selected', optionId: 'once' } }),
    JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject' } }),
    JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject' } }),
    JSON.stringify({ outcome: { outcome: 'selected', optionId: 'once' } }),
  ]);
  expect(calls.find((c) => c.method === 'session/set_mode')).toMatchObject({
    params: { modeId: 'agenthq' },
  });
  expect(events.at(-1)).toMatchObject({
    text: 'S11_WORK_OK',
    costUsd: 1,
    isError: false,
  });
  const options = (
    spawn.mock.calls as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ][]
  )[0]![2];
  expect(options.env.AGENTHQ_TEST_ENV).toBe('native');
});
it('refuses mismatched native identity before prompting', async () => {
  const { runtime, calls } = fixture(false, 'future', false, true);
  const events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
  expect(calls.some((c) => c.method === 'session/prompt')).toBe(false);
  expect(events.at(-1)).toMatchObject({ isError: true });
});
it('streams updates, ignores load replay, selects model, preserves server session ID and reports per-turn cost', async () => {
  const { runtime, calls, killTree, spawn } = fixture();
  const events: RunEvent[] = [];
  runtime.start({ ...req, resume: true, sessionId: session }, (e) =>
    events.push(e),
  );
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
  expect(calls.some((c) => c.method === 'session/load')).toBe(true);
  expect(calls.some((c) => c.method === 'session/set_model')).toBe(true);
  expect(
    events
      .filter((e) => e.type === 'text')
      .map((e) => e.text)
      .join(''),
  ).toBe('Hi 世界');
  expect(events.at(-1)).toMatchObject({
    type: 'done',
    text: 'Hi 世界',
    costUsd: 0.001,
    isError: false,
  });
  expect(killTree).toHaveBeenCalledOnce();
  const env = (
    spawn.mock.calls as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ][]
  )[0]![2].env;
  expect(env.AGENTHQ_READ_ROOTS).toBe(
    JSON.stringify([req.cwd, ...req.extraDirs!]),
  );
});
it.each([
  ['off', false],
  ['off', true],
  ['read', false],
  ['read', true],
  ['write', false],
  ['write', true],
] as const)(
  'passes explicit Hermes read roots/web switch for %s/%s',
  async (vaultAccess, webAccess) => {
    const { runtime, spawn, calls } = fixture(true);
    const extraDirs = [
      ...req.extraDirs!,
      ...(vaultAccess === 'write' ? ['C:/Vault'] : []),
    ];
    const readDirs = vaultAccess === 'read' ? ['C:/Vault'] : [];
    const run = runtime.start(
      { ...req, extraDirs, readDirs, webAccess },
      () => {},
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'session/prompt')).toBe(true),
    );
    const env = (
      spawn.mock.calls as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ][]
    )[0]![2].env;
    expect(env.AGENTHQ_READ_ROOTS).toBe(
      JSON.stringify([req.cwd, ...extraDirs, ...readDirs]),
    );
    expect(env.AGENTHQ_WEB_ACCESS).toBe(String(webAccess));
    await run.stop();
  },
);
it('preserves a successful reply when taskkill reports an exit race after process close', async () => {
  const { runtime } = fixture(false, 'files-v1', true);
  const events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      text: 'Hi 世界',
      isError: false,
    }),
  );
});
it('uses returned ACP IDs for new sessions and kills a pending prompt once on Stop', async () => {
  const { runtime, calls, child, killTree } = fixture(true);
  const events: RunEvent[] = [];
  const run = runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() =>
    expect(calls.some((c) => c.method === 'session/prompt')).toBe(true),
  );
  expect(events).toContainEqual({ type: 'session', sessionId: session });
  await Promise.all([run.stop(), run.stop()]);
  expect(killTree).toHaveBeenCalledOnce();
  expect(runtime.activePids).toEqual([]);
  expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  child.stdout.write('malformed\n');
});
it('routes allowed/denied edits to allow-once/reject-once and refuses unknown client methods', async () => {
  const { runtime, calls, child } = fixture(true);
  const run = runtime.start(req, () => {});
  await vi.waitFor(() =>
    expect(calls.some((c) => c.method === 'session/prompt')).toBe(true),
  );
  for (const [id, path, optionId] of [
    ['allow', 'C:/Vault/Work/a/ok.txt', 'yes'],
    ['deny', 'C:/Vault/Agents/no.md', 'no'],
  ] as const) {
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId: session,
          toolCall: {
            kind: 'edit',
            rawInput: { tool: 'write_file', arguments: { path } },
            content: [{ type: 'diff', path, newText: 'hi' }],
          },
          options: [
            { kind: 'allow_once', optionId: 'yes' },
            { kind: 'reject_once', optionId: 'no' },
          ],
        },
      }) + '\n',
    );
    await vi.waitFor(() =>
      expect(calls.find((c) => c.id === id)?.result).toEqual({
        outcome: { outcome: 'selected', optionId },
      }),
    );
  }
  child.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'terminal',
      method: 'terminal/create',
      params: {},
    }) + '\n',
  );
  await vi.waitFor(() =>
    expect(calls.find((c) => c.id === 'terminal')?.error).toMatchObject({
      code: -32601,
    }),
  );
  await run.stop();
});
it('fails closed on an incompatible policy before sending a prompt', async () => {
  const { runtime, calls } = fixture(false, 'unsafe');
  const events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
  expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
  expect(calls.some((c) => c.method === 'session/prompt')).toBe(false);
});
it('replays sanitized real Hermes permission/tool/text/cost frames without inference', async () => {
  const { runtime, calls, child } = fixture(true);
  const events: RunEvent[] = [];
  runtime.start(
    {
      ...req,
      cwd: 'C:/Vault/Mesa/Work/s10hermes',
      extraDirs: [],
      protectedPaths: ['C:/Vault/Mesa/Agents'],
    },
    (e) => events.push(e),
  );
  await vi.waitFor(() =>
    expect(calls.some((c) => c.method === 'session/prompt')).toBe(true),
  );
  const promptId = calls.find((c) => c.method === 'session/prompt')!.id;
  for (const frame of recordedPermissions) {
    const message = {
      ...frame,
      ...(frame.params
        ? { params: { ...frame.params, sessionId: session } }
        : {}),
      ...(frame.result ? { id: promptId } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    for (let i = 0; i < bytes.length; i += 17)
      child.stdout.write(bytes.subarray(i, i + 17));
    if (frame.method === 'session/request_permission')
      await vi.waitFor(() =>
        expect(calls.some((c) => c.id === frame.id && c.result)).toBe(true),
      );
  }
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      text: '\n\nFirst denied as expected, second succeeded.',
      isError: false,
      costUsd: 0,
    }),
  );
  expect(
    events.filter((e) => e.type === 'tool' && e.name === 'Edit denied'),
  ).toHaveLength(1);
  expect(
    events.filter((e) => e.type === 'tool' && e.name === 'Edit approved'),
  ).toHaveLength(2);
});
it('normalizes malformed stream output and tears down the process', async () => {
  const { runtime, calls, child } = fixture(true);
  const events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() =>
    expect(calls.some((c) => c.method === 'session/prompt')).toBe(true),
  );
  child.stdout.write('not json\n');
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true }),
  );
  expect(runtime.activePids).toEqual([]);
});
it('Hermes gets exactly Mesa’s browser server in session/new for a browser run, none otherwise, and the run folder is removed', async () => {
  const run = async (browser: boolean) => {
    const { runtime, calls } = fixture();
    const events: RunEvent[] = [];
    runtime.start({ ...req, canUseBrowser: browser }, (e) => events.push(e));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    return {
      events,
      servers: calls.find((c) => c.method === 'session/new')?.params as {
        mcpServers: { name: string; command: string; args: string[] }[];
      },
    };
  };
  const plain = await run(false);
  expect(plain.servers.mcpServers).toEqual([]);
  const withBrowser = await run(true);
  expect(withBrowser.events.at(-1)).toMatchObject({ isError: false });
  const [server] = withBrowser.servers.mcpServers;
  expect(withBrowser.servers.mcpServers).toHaveLength(1);
  expect(server).toMatchObject({
    name: 'playwright',
    command: 'C:/node/node.exe',
  });
  expect(server!.args.slice(0, 3)).toEqual([
    'C:/vault/plugin/browser_mcp.cjs',
    '--agenthq-browser',
    '--isolated',
  ]);
  expect(existsSync(server!.args[server!.args.indexOf('--run-dir') + 1]!)).toBe(
    false,
  );
});
it('refuses a browser run for the Hermes engine setting, and when the shim does not report the browser policy', async () => {
  for (const [engine, hint] of [
    ['hermes', /Hermes browser/],
    ['playwright', /browser policy/],
  ] as const) {
    const { runtime, calls } = fixture();
    // The second case: a shim that answers without the browser policy marker.
    const bare = new AcpRuntime(
      {
        id: 'hermes',
        displayName: 'Hermes',
        policy: 'files-v1',
        browserPolicy: 'other',
        browserHelper: 'C:/vault/plugin/browser_mcp.cjs',
        resolve: async () => ({ file: 'r.exe', args: [], path: 'r.exe' }),
      },
      (runtime as unknown as { deps: never }).deps,
    );
    const events: RunEvent[] = [];
    (engine === 'hermes' ? runtime : bare).start(
      { ...req, canUseBrowser: true, browserEngine: engine },
      (e) => events.push(e),
    );
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.at(-1)).toMatchObject({ isError: true });
    expect((events.at(-1) as { text: string }).text).toMatch(hint);
    expect(calls.find((c) => c.method === 'session/new')).toBeUndefined();
  }
});
it('Hermes gets Mesa’s Microsoft 365 helper next to the browser, only when the run has it', async () => {
  const m365Launch = {
    node: 'C:/node/node.exe',
    helper: 'C:/vault/plugin/m365_mcp.cjs',
    tokenFile: 'C:/tmp/run/token.json',
    outbox: 'C:/tmp/run/outbox',
  };
  const run = async (extra: Partial<RunRequest>) => {
    const { runtime, calls } = fixture();
    const events: RunEvent[] = [];
    runtime.start({ ...req, ...extra }, (e) => events.push(e));
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    return (
      calls.find((c) => c.method === 'session/new')?.params as {
        mcpServers: { name: string; args: string[] }[];
      }
    ).mcpServers;
  };
  expect(await run({})).toEqual([]);
  const servers = await run({ m365Launch });
  expect(servers.map((s) => s.name)).toEqual(['m365']);
  expect(servers[0]!.args.slice(0, 2)).toEqual([
    'C:/vault/plugin/m365_mcp.cjs',
    '--agenthq-m365',
  ]);
  const both = await run({ m365Launch, canUseBrowser: true });
  expect(both.map((s) => s.name)).toEqual(['playwright', 'm365']);
});
