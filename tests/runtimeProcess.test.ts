import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { ClaudeCodeRuntime } from '../src/core/runtimes/claudeCode';
import type { RunEvent, RunRequest } from '../src/core/runtimes/types';

const request: RunRequest = {
  prompt: 'hi',
  systemPrompt: '',
  cwd: 'C:/vault/Notes',
  sessionId: 'a05d12f5-5b75-4b92-8296-9c43288d8182',
  resume: false,
  permission: 'read-only',
};
function processFixture() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: 12345,
  }) as unknown as ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
}
function setup() {
  const child = processFixture();
  const killTree = vi.fn(async () => {
    child.emit('close', null, 'SIGKILL');
  });
  const spawn = vi.fn(
    (_file: string, _args: string[], _options: SpawnOptionsWithoutStdio) =>
      child,
  );
  const runtime = new ClaudeCodeRuntime(
    { protectedPaths: ['C:/vault/.obsidian'] },
    {
      findExecutable: async () => ({
        path: 'C:/runtime.exe',
        file: 'C:/runtime.exe',
        args: [],
      }),
      probe: async (_file, args) =>
        args[0] === '--version'
          ? '2.1.286'
          : '--restricted --safe-mode --permission-prompts --tools --strict-mcp-config',
      spawn,
      killTree,
    },
  );
  return { runtime, child, spawn, killTree };
}

it('sends large Unicode prompts on stdin and uses a short system-prompt file argument', async () => {
  const { runtime, child, spawn } = setup();
  const prompt = '漢😀&'.repeat(25000);
  const systemPrompt = 'system é😀'.repeat(5000);
  let input = '';
  child.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
  });
  runtime.start({ ...request, prompt, systemPrompt }, () => {});
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const args = spawn.mock.calls[0]![1];
  expect(args.join(' ').length).toBeLessThan(8000);
  expect(args).not.toContain(prompt);
  expect(args).not.toContain(systemPrompt);
  expect(args).not.toContain('--append-system-prompt');
  expect(args).toContain('--append-system-prompt-file');
  expect(input).toBe(prompt);
  expect(child.stdin.writableEnded).toBe(true);
  const path = args[args.indexOf('--append-system-prompt-file') + 1]!;
  expect(await readFile(path, 'utf8')).toBe(systemPrompt);
  child.emit('close', 0, null);
  await vi.waitFor(async () => {
    await expect(access(path)).rejects.toThrow();
  });
});

it.each([false, true])(
  'removes the system file after runtime failure or stop (stop=%s)',
  async (stop) => {
    const { runtime, child, spawn } = setup();
    const run = runtime.start(request, () => {});
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const args = spawn.mock.calls[0]![1];
    expect(args).toContain('--append-system-prompt-file');
    const path = args[args.indexOf('--append-system-prompt-file') + 1]!;
    if (stop) await run.stop();
    else {
      child.emit('error', new Error('spawn failure'));
      child.emit('close', -1, null);
    }
    await vi.waitFor(async () => {
      await expect(access(path)).rejects.toThrow();
    });
  },
);

it('removes the temporary system file when spawn throws synchronously', async () => {
  const { runtime, spawn } = setup();
  spawn.mockImplementationOnce(() => {
    throw new Error('spawn ENAMETOOLONG');
  });
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  const args = spawn.mock.calls[0]![1];
  const path = args[args.indexOf('--append-system-prompt-file') + 1]!;
  await expect(access(path)).rejects.toThrow();
  expect(events[0]).toMatchObject({
    type: 'done',
    isError: true,
    text: 'spawn ENAMETOOLONG',
  });
});

it.each([
  ['ENOENT', 'not-found'],
  ['EACCES', 'other'],
])('normalizes async spawn errors %s exactly once', async (code, kind) => {
  const { runtime, child, spawn } = setup();
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  expect(() =>
    child.emit(
      'error',
      Object.assign(new Error('Unable to launch runtime.'), { code }),
    ),
  ).not.toThrow();
  child.emit('close', -1, null);
  expect(events).toEqual([
    {
      type: 'done',
      text: 'Unable to launch runtime.',
      isError: true,
      errorKind: kind,
    },
  ]);
});

it.each(['stdin', 'stdout', 'stderr'] as const)(
  'normalizes %s pipe failures instead of crashing the host',
  async (pipe) => {
    const { runtime, child, spawn } = setup();
    const events: RunEvent[] = [];
    runtime.start(request, (event) => events.push(event));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(() =>
      child[pipe].emit('error', new Error('Broken runtime pipe')),
    ).not.toThrow();
    child.emit('close', 1, null);
    expect(events).toEqual([
      {
        type: 'done',
        text: 'Broken runtime pipe',
        isError: true,
        errorKind: 'other',
      },
    ]);
  },
);

it('uses stderr on failed exits, classifies authentication, and gives sign-in guidance', async () => {
  const { runtime, child, spawn } = setup();
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stderr.write('Authentication required.');
  child.emit('close', 1, null);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'done',
    isError: true,
    errorKind: 'auth',
  });
  expect(events[0]?.type === 'done' && events[0].text).toContain(
    'Open a terminal',
  );
});

it('rejects a missing CLI with actionable not-found guidance without spawning', async () => {
  const spawn = vi.fn();
  const runtime = new ClaudeCodeRuntime(
    { protectedPaths: ['C:/vault/.obsidian'] },
    { findExecutable: async () => undefined, spawn },
  );
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(events[0]).toMatchObject({
    type: 'done',
    isError: true,
    errorKind: 'not-found',
  });
  expect(spawn).not.toHaveBeenCalled();
});

it('never exposes an unverified executable while detection is still checking policy flags', async () => {
  const spawn = vi.fn();
  let release!: (help: string) => void;
  const help = new Promise<string>((resolve) => {
    release = resolve;
  });
  const runtime = new ClaudeCodeRuntime(
    { protectedPaths: ['C:/vault/.obsidian'] },
    {
      findExecutable: async () => ({
        path: 'C:/runtime.exe',
        file: 'C:/runtime.exe',
        args: [],
      }),
      probe: async (_file, args) => (args[0] === '--version' ? 'old' : help),
      spawn,
    },
  );
  const detection = runtime.detect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  release('old help without required flags');
  expect((await detection).available).toBe(false);
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(spawn).not.toHaveBeenCalled();
});

it('stops the process tree once and suppresses data after stop', async () => {
  const { runtime, child, spawn, killTree } = setup();
  const events: RunEvent[] = [];
  const run = runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stdout.write(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
  );
  await Promise.all([run.stop(), run.stop()]);
  child.stdout.write(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"late"}]}}\n',
  );
  expect(killTree).toHaveBeenCalledExactlyOnceWith(12345);
  expect(events).toEqual([
    { type: 'text', text: 'partial' },
    { type: 'done', text: 'Run stopped.', isError: true, errorKind: 'other' },
  ]);
  expect(runtime.activePids).toEqual([]);
});

it('allows teardown to be retried after a tree-kill failure', async () => {
  const { runtime, child, spawn, killTree } = setup();
  killTree.mockRejectedValueOnce(new Error('access denied'));
  const events: RunEvent[] = [];
  const run = runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  await expect(run.stop()).rejects.toThrow('access denied');
  expect(runtime.activePids).toEqual([child.pid]);
  expect(events).toEqual([]);
  await run.stop();
  expect(killTree).toHaveBeenCalledTimes(2);
  expect(runtime.activePids).toEqual([]);
  expect(events).toEqual([
    { type: 'done', text: 'Run stopped.', isError: true, errorKind: 'other' },
  ]);
});

it('stops before discovery completes without spawning or leaving the queue waiting', async () => {
  const { runtime, spawn } = setup();
  const events: RunEvent[] = [];
  const run = runtime.start(request, (event) => events.push(event));
  await run.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(spawn).not.toHaveBeenCalled();
  expect(events).toEqual([
    { type: 'done', text: 'Run stopped.', isError: true, errorKind: 'other' },
  ]);
});

it.each([1, null])(
  'does not report success when a result is followed by unsuccessful exit %s',
  async (code) => {
    const { runtime, child, spawn } = setup();
    const events: RunEvent[] = [];
    runtime.start(request, (event) => events.push(event));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(
      '{"type":"result","result":"answer","is_error":false,"total_cost_usd":0.01}\n',
    );
    child.emit('close', code, code === null ? 'SIGTERM' : null);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'done',
      isError: true,
      errorKind: 'other',
      costUsd: 0.01,
    });
  },
);

it('drains an unterminated error result before classifying a failed exit', async () => {
  const { runtime, child, spawn } = setup();
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stdout.write(
    JSON.stringify({
      type: 'result',
      is_error: true,
      errors: ['Authentication required'],
    }),
  );
  child.emit('close', 1, null);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'done',
    isError: true,
    errorKind: 'auth',
  });
  expect(events[0]?.type === 'done' && events[0].text).toContain(
    'Authentication required',
  );
});

it('subtracts the persisted cumulative session cost on resume', async () => {
  const { runtime, child, spawn } = setup();
  const events: RunEvent[] = [];
  runtime.start({ ...request, resume: true, previousCostUsd: 0.02 }, (event) =>
    events.push(event),
  );
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  child.stdout.write('{"type":"result","result":"ok","total_cost_usd":0.03}\n');
  child.emit('close', 0, null);
  const done = events.at(-1);
  expect(done?.type === 'done' && done.costUsd).toBeCloseTo(0.01);
});

it('detects, spawns without a shell, streams and completes only once the process closes', async () => {
  const { runtime, child, spawn } = setup();
  expect(await runtime.detect()).toMatchObject({
    available: true,
    version: '2.1.286',
    path: 'C:/runtime.exe',
  });
  const events: RunEvent[] = [];
  runtime.start(request, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({
    shell: false,
    cwd: request.cwd,
    windowsHide: true,
  });
  expect(runtime.activePids).toEqual([12345]);
  expect(child.stdin.writableEnded).toBe(true);
  child.stdout.write(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
  );
  child.stdout.write(
    '{"type":"result","is_error":false,"result":"hi","total_cost_usd":0.01}\n',
  );
  expect(events).toEqual([{ type: 'text', text: 'hi' }]);
  child.emit('close', 0, null);
  expect(events.at(-1)).toEqual({
    type: 'done',
    text: 'hi',
    costUsd: 0.01,
    isError: false,
  });
  expect(runtime.activePids).toEqual([]);
});
