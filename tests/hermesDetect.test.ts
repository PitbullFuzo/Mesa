import { expect, it } from 'vitest';
import { findHermesPython } from '../src/core/runtimes/hermes';
it('finds Windows PATH and known install locations without invoking cmd files', async () => {
  const exists = async (p: string) =>
    ['C:/tools/hermes.exe', 'C:/tools/python.exe'].includes(
      p.replace(/\\/g, '/'),
    );
  expect(
    (
      await findHermesPython({
        platform: 'win32',
        env: { PATH: 'C:/tools', USERPROFILE: 'C:/User' },
        exists,
      })
    )?.file.replace(/\\/g, '/'),
  ).toBe('C:/tools/python.exe');
  const known = async (p: string) =>
    [
      'C:/Local/hermes/bin/hermes.cmd',
      'C:/Local/hermes/hermes-agent/venv/Scripts/python.exe',
    ].includes(p.replace(/\\/g, '/'));
  expect(
    (
      await findHermesPython({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:/Local', PATH: '' },
        exists: known,
      })
    )?.file.replace(/\\/g, '/'),
  ).toBe('C:/Local/hermes/hermes-agent/venv/Scripts/python.exe');
});
it('finds a macOS venv installation and returns missing when ACP has no safe interpreter', async () => {
  const exists = async (p: string) =>
    [
      '/home/u/.hermes/hermes-agent/venv/bin/hermes',
      '/home/u/.hermes/hermes-agent/venv/bin/python',
    ].includes(p);
  expect(
    (
      await findHermesPython({
        platform: 'darwin',
        env: { HOME: '/home/u', PATH: '' },
        exists,
      })
    )?.file,
  ).toBe('/home/u/.hermes/hermes-agent/venv/bin/python');
  expect(
    await findHermesPython({
      platform: 'win32',
      env: { PATH: '' },
      exists: async () => false,
    }),
  ).toBeUndefined();
});
