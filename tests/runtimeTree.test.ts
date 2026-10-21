import { expect, it, vi } from 'vitest';
import { killProcessTree } from '../src/core/runtimes/processTree';

it('uses Windows taskkill with an argument array to force-kill descendants', async () => {
  const exec = vi.fn(async (_file: string, _args: string[]) => undefined);
  const kill = vi.fn();
  await killProcessTree(321, 'win32', { exec, kill });
  expect(exec.mock.calls[0]?.[0]).toMatch(/taskkill\.exe$/i);
  expect(exec.mock.calls[0]?.[1]).toEqual(['/pid', '321', '/T', '/F']);
  expect(kill).not.toHaveBeenCalled();
});
it('kills a detached POSIX process group and tolerates an already-dead group', async () => {
  const kill = vi.fn(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  await killProcessTree(321, 'darwin', { exec: vi.fn(), kill });
  expect(kill).toHaveBeenCalledExactlyOnceWith(-321, 'SIGKILL');
});
