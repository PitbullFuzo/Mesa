import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCodexSandboxSelfTest } from '../src/core/runtimes/codexSelfTest';

/**
 * Stands in for the codex and powershell processes. A control is the call without "sandbox" in its arguments.
 * A sandboxed probe gets the scripted output; the inside probe also writes the file it claims to write.
 */
function fakeCapture(options: {
  control: string;
  inside?: string;
  outside?: string;
  network?: string;
}) {
  return async (file: string, args: string[]) => {
    if (!args.includes('sandbox')) return options.control;
    const work = args[args.indexOf('-C') + 1]!;
    const script = args[args.length - 1]!;
    if (script.includes('in.txt') && options.inside?.includes('IN_WRITE_OK'))
      fs.writeFileSync(path.join(work, 'in.txt'), 'ok');
    if (script.includes('out.txt')) return options.outside ?? '';
    if (script.includes('example.com')) return options.network ?? '';
    return options.inside ?? '';
  };
}

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'agenthq-selftest-'));
const FILE = 'C:/codex.exe';

describe('the Codex self-test outcomes', () => {
  it('passes when the control reaches the internet and every probe behaves as required', async () => {
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'win32',
      capture: fakeCapture({
        control: 'NET_OK',
        inside: 'PROBE_RAN\nIN_WRITE_OK',
        outside: 'PROBE_RAN\nOUT_BLOCKED',
        network: 'PROBE_RAN\nNET_BLOCKED',
      }),
    });
    expect(outcome.result).toBe('pass');
  });

  it('is unsupported when the control cannot reach the internet, and never runs the sandbox probes', async () => {
    const calls: string[][] = [];
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'win32',
      capture: async (file, args) => {
        calls.push(args);
        return 'NET_BLOCKED';
      },
    });
    expect(outcome.result).toBe('unsupported');
    expect(outcome.detail).toBe("Can't check now: no internet. Will retry.");
    expect(calls.every((args) => !args.includes('sandbox'))).toBe(true);
  });

  it('is unsupported, not a breach, when a probe times out and never prints its marker', async () => {
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'win32',
      capture: fakeCapture({
        control: 'NET_OK',
        inside: '',
        outside: '',
        network: '',
      }),
    });
    expect(outcome.result).toBe('unsupported');
  });

  it('is a real breach when an outside write goes through, with every probe having run', async () => {
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'win32',
      capture: fakeCapture({
        control: 'NET_OK',
        inside: 'PROBE_RAN\nIN_WRITE_OK',
        outside: 'PROBE_RAN\nOUT_WROTE',
        network: 'PROBE_RAN\nNET_BLOCKED',
      }),
    });
    expect(outcome.result).toBe('fail');
    expect(outcome.detail).toContain('outside');
  });

  it('is a real breach when the network request goes through in the sandbox', async () => {
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'win32',
      capture: fakeCapture({
        control: 'NET_OK',
        inside: 'PROBE_RAN\nIN_WRITE_OK',
        outside: 'PROBE_RAN\nOUT_BLOCKED',
        network: 'PROBE_RAN\nNET_OK',
      }),
    });
    expect(outcome.result).toBe('fail');
  });

  it('is unsupported on systems without a free check', async () => {
    const outcome = await runCodexSandboxSelfTest(FILE, scratch(), {
      platform: 'darwin',
    });
    expect(outcome.result).toBe('unsupported');
  });
});
