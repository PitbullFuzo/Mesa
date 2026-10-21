import { describe, expect, it, vi } from 'vitest';
import { CodexRuntime } from '../src/core/runtimes/codex';
import type { Executable } from '../src/core/runtimes/detect';
import type {
  SelfTestMemory,
  SelfTestOutcome,
} from '../src/core/runtimes/selfTest';

const executable: Executable = {
  file: 'C:/codex.exe',
  args: [],
  path: 'C:/codex.exe',
};

function codex(
  version: string,
  options: {
    selfTest?: () => Promise<SelfTestOutcome>;
    selfTests?: SelfTestMemory;
  } = {},
) {
  const memory: SelfTestMemory = options.selfTests ?? {};
  const selfTest = vi.fn(
    options.selfTest ??
      (async () => ({ result: 'pass' as const, detail: 'ok' })),
  );
  const runtime = new CodexRuntime({
    find: async () => executable,
    probe: async () => version,
    selfTests: memory,
    rememberSelfTest: (key, record) => {
      memory[key] = record;
    },
    selfTest,
  });
  return { runtime, memory, selfTest };
}

describe('Codex version policy', () => {
  it('runs the verified 0.160.0 without a self-test', async () => {
    const { runtime, selfTest } = codex('codex-cli 0.160.0');
    expect(await runtime.detect()).toMatchObject({ available: true });
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('blocks an older Codex and never runs the self-test for it', async () => {
    const { runtime, selfTest } = codex('codex-cli 0.150.0');
    const status = await runtime.detect();
    expect(status).toMatchObject({
      available: false,
      blocked: true,
      version: 'codex-cli 0.150.0',
    });
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('allows a newer Codex after its self-test passes, and remembers the pass', async () => {
    const { runtime, memory, selfTest } = codex('codex-cli 0.163.0');
    const status = await runtime.detect();
    expect(status.available).toBe(true);
    expect(status.hint).toContain('not yet verified by the developer');
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(memory['codex 0.163.0']?.result).toBe('pass');
  });

  it('runs a newer version self-test once, even across repeated detections', async () => {
    const { runtime, selfTest } = codex('codex-cli 0.163.0');
    await runtime.detect();
    await runtime.detect();
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('blocks a newer Codex whose self-test fails, with the plain message', async () => {
    const { runtime, memory } = codex('codex-cli 0.164.0', {
      selfTest: async () => ({
        result: 'fail',
        detail: 'the sandbox let a network request through',
      }),
    });
    const status = await runtime.detect();
    expect(status).toMatchObject({ available: false, blocked: true });
    expect(status.hint).toContain(
      'This Codex version changed its safety settings. Use 0.160.0',
    );
    expect(memory['codex 0.164.0']?.result).toBe('fail');
  });

  it('an offline or timed-out check is not blocked and not remembered: the next detection tries again', async () => {
    const { runtime, memory, selfTest } = codex('codex-cli 0.163.0', {
      selfTest: async () => ({
        result: 'unsupported',
        detail: "Can't check now: no internet. Will retry.",
      }),
    });
    const status = await runtime.detect();
    expect(status).toMatchObject({
      available: false,
      hint: "Can't check now: no internet. Will retry.",
    });
    expect(status.blocked).toBeUndefined();
    expect(memory).toEqual({});
    await runtime.detect();
    expect(selfTest).toHaveBeenCalledTimes(2);
  });

  it('re-running the safety check (clearing the memory) runs the self-test again for a blocked version', async () => {
    const memory: SelfTestMemory = {
      'codex 0.164.0': {
        result: 'fail' as const,
        detail: 'old breach',
        checkedAt: 'x',
      },
    };
    const { runtime, selfTest } = codex('codex-cli 0.164.0', {
      selfTests: memory,
    });
    expect((await runtime.detect()).available).toBe(false);
    expect(selfTest).not.toHaveBeenCalled();
    for (const key of Object.keys(memory)) delete memory[key];
    expect((await runtime.detect()).available).toBe(true);
    expect(selfTest).toHaveBeenCalledTimes(1);
  });

  it('uses a remembered failure without running the self-test again', async () => {
    const { runtime, selfTest } = codex('codex-cli 0.164.0', {
      selfTests: {
        'codex 0.164.0': { result: 'fail', detail: 'earlier', checkedAt: 'x' },
      },
    });
    expect((await runtime.detect()).available).toBe(false);
    expect(selfTest).not.toHaveBeenCalled();
  });
});
