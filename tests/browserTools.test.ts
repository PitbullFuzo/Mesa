import { expect, it } from 'vitest';
import {
  findBrowserNode,
  browserCachePath,
  browserInstallArgs,
} from '../src/core/runtimes/browserTools';
it('pins setup dependencies and preserves existing browser caches', () => {
  const args = browserInstallArgs(
    { node: 'node', npm: 'npm-cli.js', npx: 'npx-cli.js' },
    'C:/tools',
  );
  expect(args[0]).toContain('@playwright/mcp@0.0.83');
  expect(args[0]).toContain('--ignore-scripts');
  expect(args[1]).toContain('--no-remove');
  expect(args[1]).toContain('--no-shell');
  expect(args.flat()).not.toContain('--with-deps');
});
it('finds Windows native Node/npm/npx and never invokes command shims', async () => {
  const files = [
    'C:/tools/node.exe',
    'C:/tools/node_modules/npm/bin/npm-cli.js',
    'C:/tools/node_modules/npm/bin/npx-cli.js',
  ];
  expect(
    await findBrowserNode({
      platform: 'win32',
      env: { PATH: 'C:/tools' },
      exists: async (p) => files.includes(p.replace(/\\/g, '/')),
    }),
  ).toEqual({
    node: 'C:\\tools\\node.exe',
    npm: 'C:\\tools\\node_modules\\npm\\bin\\npm-cli.js',
    npx: 'C:\\tools\\node_modules\\npm\\bin\\npx-cli.js',
  });
});
it('finds Finder/Homebrew and nvm Node layouts and platform browser caches', async () => {
  for (const node of [
    '/opt/homebrew/bin/node',
    '/home/u/.nvm/versions/node/v26.1.0/bin/node',
  ]) {
    const dir = node.slice(0, -5);
    const root = dir.endsWith('/bin') ? dir.slice(0, -4) : dir;
    const result = await findBrowserNode({
      platform: 'darwin',
      env: { HOME: '/home/u', PATH: '' },
      readdir: async () => ['v22.1.0', 'v26.1.0'],
      exists: async (p) =>
        [
          node,
          root + '/lib/node_modules/npm/bin/npm-cli.js',
          root + '/lib/node_modules/npm/bin/npx-cli.js',
        ].includes(p),
    });
    expect(result?.node).toBe(node);
  }
  expect(browserCachePath('darwin', { HOME: '/home/u' })).toBe(
    '/home/u/Library/Caches/ms-playwright',
  );
  expect(
    browserCachePath('win32', { LOCALAPPDATA: 'C:/Local' }).replace(/\\/g, '/'),
  ).toBe('C:/Local/ms-playwright');
});
