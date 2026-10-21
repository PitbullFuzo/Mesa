import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

interface TreeDependencies {
  exec: (file: string, args: string[]) => Promise<unknown>;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
}
const defaults: TreeDependencies = {
  exec: (file, args) =>
    promisify(execFile)(file, args, {
      shell: false,
      windowsHide: true,
      timeout: 10000,
    }),
  kill: (pid, signal) => process.kill(pid, signal),
};

export async function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  deps: TreeDependencies = defaults,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error('Invalid runtime process ID.');
  if (platform === 'win32') {
    await deps.exec(
      join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
      ['/pid', String(pid), '/T', '/F'],
    );
  } else {
    try {
      deps.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
