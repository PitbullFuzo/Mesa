import { describe, expect, it, vi } from 'vitest';
import {
  clearSafetyChecks,
  judgeSandboxProbes,
  selfTestOnce,
  type SelfTestMemory,
  type SelfTestOutcome,
  type SelfTestRecord,
} from '../src/core/runtimes/selfTest';

const good = {
  control: true,
  ran: true,
  insideWritten: true,
  outsideWritten: false,
  networkReached: false,
  output: ['IN_WRITE_OK', 'OUT_BLOCKED', 'NET_BLOCKED'],
};

describe('sandbox probe judgement', () => {
  it('passes only when the project folder is writable and the outside write and network are refused', () => {
    expect(judgeSandboxProbes(good).result).toBe('pass');
  });

  it('fails when the outside write goes through', () => {
    expect(judgeSandboxProbes({ ...good, outsideWritten: true }).result).toBe(
      'fail',
    );
  });

  it('fails when the network request goes through', () => {
    expect(judgeSandboxProbes({ ...good, networkReached: true }).result).toBe(
      'fail',
    );
  });

  it('fails when the inside write is refused while the command itself ran', () => {
    expect(judgeSandboxProbes({ ...good, insideWritten: false }).result).toBe(
      'fail',
    );
  });

  it('fails when the sandbox reports unknown or renamed settings', () => {
    const warned = {
      ...good,
      output: [...good.output, 'Warning: unknown config key'],
    };
    expect(judgeSandboxProbes(warned).result).toBe('fail');
  });

  it('is unsupported, not a breach, when the offline control did not reach the internet', () => {
    const offline = judgeSandboxProbes({
      ...good,
      control: false,
      networkReached: false,
    });
    expect(offline.result).toBe('unsupported');
    expect(offline.detail).toBe("Can't check now: no internet. Will retry.");
  });

  it('is unsupported, not a breach, when a probe never printed its marker (timeout or crash)', () => {
    expect(
      judgeSandboxProbes({ ...good, ran: false, insideWritten: false }).result,
    ).toBe('unsupported');
  });
});

describe('self-test memory', () => {
  it('runs a version once: the second call reuses the remembered result', async () => {
    const memory: SelfTestMemory = {};
    const remember = vi.fn((key: string, record: SelfTestRecord) => {
      memory[key] = record;
    });
    const run = vi.fn(async () => ({ result: 'pass' as const, detail: 'ok' }));
    const pending = new Map<string, Promise<SelfTestOutcome>>();
    const first = await selfTestOnce(
      'codex 0.163.0',
      memory,
      remember,
      pending,
      run,
    );
    const second = await selfTestOnce(
      'codex 0.163.0',
      memory,
      remember,
      pending,
      run,
    );
    expect(first.result).toBe('pass');
    expect(second.result).toBe('pass');
    expect(run).toHaveBeenCalledTimes(1);
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('shares one run between callers that start together', async () => {
    const memory: SelfTestMemory = {};
    const run = vi.fn(async () => ({ result: 'fail' as const, detail: 'no' }));
    const pending = new Map<string, Promise<SelfTestOutcome>>();
    const remember = (key: string, record: SelfTestRecord) => {
      memory[key] = record;
    };
    await Promise.all([
      selfTestOnce('codex 0.163.0', memory, remember, pending, run),
      selfTestOnce('codex 0.163.0', memory, remember, pending, run),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not remember an unsupported check, and reports it as unsupported so it is retried', async () => {
    const memory: SelfTestMemory = {};
    const remember = vi.fn();
    const pending = new Map<string, Promise<SelfTestOutcome>>();
    const outcome = await selfTestOnce(
      'codex 0.163.0',
      memory,
      remember,
      pending,
      async () => ({
        result: 'unsupported',
        detail: "Can't check now: no internet. Will retry.",
      }),
    );
    expect(outcome.result).toBe('unsupported');
    expect(remember).not.toHaveBeenCalled();
    expect(memory).toEqual({});
  });

  it('treats a run that throws as unsupported, not as a breach', async () => {
    const memory: SelfTestMemory = {};
    const remember = vi.fn();
    const pending = new Map<string, Promise<SelfTestOutcome>>();
    const outcome = await selfTestOnce(
      'codex 0.163.0',
      memory,
      remember,
      pending,
      async () => {
        throw new Error('spawn failed');
      },
    );
    expect(outcome.result).toBe('unsupported');
    expect(remember).not.toHaveBeenCalled();
  });

  it('clearing the stored results makes the next check run again', async () => {
    const memory: SelfTestMemory = {
      'codex 0.163.0': { result: 'fail', detail: 'old breach', checkedAt: 'x' },
    };
    expect(clearSafetyChecks(memory)).toBe(1);
    expect(memory).toEqual({});
    const run = vi.fn(async () => ({ result: 'pass' as const, detail: 'ok' }));
    const outcome = await selfTestOnce(
      'codex 0.163.0',
      memory,
      (key, record) => (memory[key] = record),
      new Map(),
      run,
    );
    expect(outcome.result).toBe('pass');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
