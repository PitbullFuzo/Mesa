import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { findRuntimeExecutable } from '../src/core/runtimes/detect';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const scratch = process.env.HERMES_HOME
    ? join(process.env.HERMES_HOME, 'cache', 'scratch')
    : tmpdir();
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'runtime-detect-'));
  roots.push(root);
  return root;
}

it('gives an explicit override priority and never silently falls back when invalid', async () => {
  const home = await fixture();
  const bin = join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude.exe'), 'fixture');
  const override = join(home, 'custom.exe');
  await writeFile(override, 'fixture');
  const options = {
    platform: 'win32' as const,
    env: { USERPROFILE: home, PATH: '' },
  };
  expect(
    (await findRuntimeExecutable({ ...options, runtimePathOverride: override }))
      ?.path,
  ).toBe(override);
  expect(
    await findRuntimeExecutable({
      ...options,
      runtimePathOverride: join(home, 'missing.exe'),
    }),
  ).toBeUndefined();
});

it('searches PATH first and resolves an npm cmd shim through its JS entry, never cmd.exe', async () => {
  const home = await fixture();
  const pathBin = join(home, 'path bin');
  await mkdir(pathBin);
  const shim = join(pathBin, 'claude.cmd');
  await writeFile(shim, '@echo off');
  const entry = join(
    pathBin,
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  await mkdir(join(pathBin, 'node_modules', '@anthropic-ai', 'claude-code'), {
    recursive: true,
  });
  await writeFile(entry, '// fixture');
  const found = await findRuntimeExecutable({
    platform: 'win32',
    env: { USERPROFILE: home, PATH: pathBin },
  });
  expect(found).toEqual({ path: shim, file: process.execPath, args: [entry] });
  await rm(entry);
  expect(
    await findRuntimeExecutable({
      platform: 'win32',
      env: { USERPROFILE: home, PATH: pathBin },
    }),
  ).toBeUndefined();
});

it('finds the macOS home install and ignores non-executable PATH files', async () => {
  const home = await fixture();
  const bin = join(home, '.npm-global', 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'claude');
  await writeFile(executable, 'fixture', { mode: 0o755 });
  expect(
    (
      await findRuntimeExecutable({
        platform: 'darwin',
        env: { HOME: home, PATH: '' },
      })
    )?.path,
  ).toBe(executable);
});

it('finds native executables in quoted Windows PATH entries', async () => {
  const home = await fixture();
  const bin = join(home, 'quoted bin');
  await mkdir(bin);
  const executable = join(bin, 'claude.exe');
  await writeFile(executable, 'fixture');
  expect(
    await findRuntimeExecutable({
      platform: 'win32',
      env: { Path: `"${bin}"` },
    }),
  ).toEqual({ path: executable, file: executable, args: [] });
});

it('finds the Windows known native install when PATH is empty', async () => {
  const home = await fixture();
  const bin = join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const executable = join(bin, 'claude.exe');
  await writeFile(executable, 'fixture');
  const found = await findRuntimeExecutable({
    platform: 'win32',
    env: { USERPROFILE: home, PATH: '' },
  });
  expect(found).toEqual({ path: executable, file: executable, args: [] });
});
