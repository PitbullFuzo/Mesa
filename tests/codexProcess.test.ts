import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { CodexRuntime } from '../src/core/runtimes/codex';
import type { RunEvent, RunRequest } from '../src/core/runtimes/types';
const req: RunRequest = {
  cwd: 'C:/Vault/HQ/Work/a',
  prompt: '世界'.repeat(30000),
  systemPrompt: 'Instructions',
  sessionId: '11111111-1111-4111-8111-111111111111',
  resume: false,
  permission: 'read-only',
  wholeComputerReadConfirmed: true,
  protectedPaths: ['C:/Vault/.obsidian'],
};
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const killTree = vi.fn(async () => {
    child.emit('close', null);
  });
  const runtime = new CodexRuntime({
    find: async () => ({ file: 'codex.exe', path: 'codex.exe', args: [] }),
    probe: async () => 'codex-cli 0.160.0',
    spawn,
    killTree,
  });
  return { child, spawn, killTree, runtime };
}
it('sends a long Unicode prompt only via stdin and waits for process close before reporting success', async () => {
  const { runtime, child, spawn } = fixture(),
    events: RunEvent[] = [];
  let input = '';
  child.stdin.on('data', (c: Buffer) => (input += c.toString()));
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  expect(input).toContain(req.prompt);
  expect(JSON.stringify(spawn.mock.calls)).not.toContain(req.prompt);
  child.stdout.write(
    JSON.stringify({ type: 'thread.started', thread_id: req.sessionId }) +
      '\n' +
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      }) +
      '\n',
  );
  expect(events.at(-1)?.type).not.toBe('done');
  child.emit('close', 0);
  expect(events.at(-1)).toMatchObject({ type: 'done', isError: false });
  expect(runtime.activePids).toEqual([]);
});
it('Stop waits for tree teardown and emits done once, including a close/kill race', async () => {
  const { runtime, spawn, killTree } = fixture(),
    events: RunEvent[] = [];
  const run = runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  await run.stop();
  await run.stop();
  expect(killTree).toHaveBeenCalledTimes(1);
  expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  expect(runtime.activePids).toEqual([]);
});
it('does not spawn without broad-read consent', async () => {
  const { runtime, spawn } = fixture(),
    events: RunEvent[] = [];
  runtime.start({ ...req, wholeComputerReadConfirmed: false }, (e) =>
    events.push(e),
  );
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true }),
  );
  expect(spawn).not.toHaveBeenCalled();
});
it('kills a malformed-output process before completing the failed run', async () => {
  const { runtime, spawn, child, killTree } = fixture(),
    events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  child.stdout.write('{bad\n');
  await vi.waitFor(() => expect(killTree).toHaveBeenCalled());
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true }),
  );
  expect(runtime.activePids).toEqual([]);
});
it('tears down a child when stdin setup throws synchronously', async () => {
  const { runtime, spawn, child, killTree } = fixture();
  vi.spyOn(child.stdin, 'end').mockImplementation(() => {
    throw Error('stdin setup failed');
  });
  const events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  await vi.waitFor(() => expect(killTree).toHaveBeenCalled());
  expect(runtime.activePids).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
});
it('does not report success after a nonzero exit', async () => {
  const { runtime, spawn, child } = fixture(),
    events: RunEvent[] = [];
  runtime.start(req, (e) => events.push(e));
  await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
  child.stdout.write(
    JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n',
  );
  child.emit('close', 1);
  expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
});
