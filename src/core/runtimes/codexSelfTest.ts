import { execFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeSandboxProbes, type SelfTestOutcome } from './selfTest';

/**
 * The Codex sandbox profile used by the self-test. It mirrors Obi-I's exec settings: the project folder is the
 * only writable place, and network access is off. Verified with the installed CLI (see docs/DECISIONS.md).
 */
const PROFILE = [
  '-P',
  'agenthq',
  '-c',
  'default_permissions="agenthq"',
  '-c',
  'permissions.agenthq.filesystem={":root"="read",":project_roots"={"."="write"}}',
  '-c',
  'permissions.agenthq.network={enabled=false}',
  '-c',
  'windows.sandbox="unelevated"',
];

const NETWORK_SCRIPT =
  'Write-Output PROBE_RAN; try { Invoke-WebRequest -UseBasicParsing https://example.com -TimeoutSec 15 | Out-Null; Write-Output NET_OK } catch { Write-Output NET_BLOCKED }';

/** Runs a command with no stdin and returns its stdout and stderr together, even when it fails. No shell is used. */
export function captureCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve(`${stdout}\n${stderr}\n${error ? error.message : ''}`);
      },
    );
    child.stdin?.end();
  });
}

export interface CodexSelfTestOptions {
  /** Runs one command; injected by the tests. */
  capture?: (
    file: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<string>;
  platform?: NodeJS.Platform;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * The free Codex self-test, no model call. First a control: the network request runs without any sandbox, and it
 * must reach the internet, or the check is unsupported (offline). Then three sandboxed probes: the project folder
 * must be writable; the outside write and the network must be refused. Windows only for now; other systems return
 * "unsupported".
 */
export async function runCodexSandboxSelfTest(
  file: string,
  scratch: string,
  options: CodexSelfTestOptions = {},
): Promise<SelfTestOutcome> {
  const platform = options.platform ?? process.platform;
  const capture = options.capture ?? captureCommand;
  if (platform !== 'win32')
    return {
      result: 'unsupported',
      detail: 'No free sandbox check exists for this system yet.',
    };
  const control = await capture(
    'powershell',
    ['-NoProfile', '-Command', NETWORK_SCRIPT],
    60_000,
  );
  if (!control.includes('NET_OK'))
    return judgeSandboxProbes({
      control: false,
      ran: false,
      insideWritten: false,
      outsideWritten: false,
      networkReached: false,
      output: [control],
    });
  const work = join(scratch, 'work');
  const outside = join(scratch, 'outside');
  await rm(scratch, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await mkdir(outside, { recursive: true });
  const probe = (script: string) =>
    capture(
      file,
      [
        'sandbox',
        '-C',
        work,
        ...PROFILE,
        'powershell',
        '-NoProfile',
        '-Command',
        script,
      ],
      120_000,
    );
  const inside = await probe(
    "Write-Output PROBE_RAN; Set-Content -Path 'in.txt' -Value ok; Write-Output IN_WRITE_OK",
  );
  const outsideText = await probe(
    `Write-Output PROBE_RAN; try { Set-Content -Path '${join(outside, 'out.txt')}' -Value bad -ErrorAction Stop; Write-Output OUT_WROTE } catch { Write-Output OUT_BLOCKED }`,
  );
  const network = await probe(NETWORK_SCRIPT);
  const output = [inside, outsideText, network];
  return judgeSandboxProbes({
    control: true,
    ran: output.every((text) => text.includes('PROBE_RAN')),
    insideWritten:
      inside.includes('IN_WRITE_OK') && (await exists(join(work, 'in.txt'))),
    outsideWritten:
      outsideText.includes('OUT_WROTE') ||
      (await exists(join(outside, 'out.txt'))),
    networkReached: network.includes('NET_OK'),
    output,
  });
}
