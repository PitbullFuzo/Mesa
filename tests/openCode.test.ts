import { expect, it } from 'vitest';
import {
  findOpenCode,
  openCodeEnvironment,
  approveOpenCode,
} from '../src/core/runtimes/openCode';
import type { RunRequest } from '../src/core/runtimes/types';
const req: RunRequest = {
  cwd: 'C:/Vault/HQ/Work/a',
  extraDirs: ['C:/Vault/HQ/Work', 'D:/project'],
  readDirs: [],
  protectedPaths: [
    'C:/Vault/.obsidian',
    'C:/Vault/HQ/Agents',
    'C:/Vault/HQ/Tasks',
    'C:/Vault/HQ/Activity',
  ],
  permission: 'edit',
  sessionId: 'id',
  resume: false,
  prompt: '',
  systemPrompt: '',
};
it('resolves Windows npm shims to native exe and macOS installer paths without invoking a shell', async () => {
  const exists = async (p: string) =>
    [
      'C:/npm/opencode.cmd',
      'C:/npm/node_modules/opencode-ai/bin/opencode.exe',
    ].includes(p.replace(/\\/g, '/'));
  expect(
    (
      await findOpenCode({ platform: 'win32', env: { PATH: 'C:/npm' }, exists })
    )?.file.replace(/\\/g, '/'),
  ).toBe('C:/npm/node_modules/opencode-ai/bin/opencode.exe');
  expect(
    (
      await findOpenCode({
        platform: 'darwin',
        env: { HOME: '/u', PATH: '' },
        exists: async (p) => p === '/u/.opencode/bin/opencode',
      })
    )?.file,
  ).toBe('/u/.opencode/bin/opencode');
  expect(
    await findOpenCode({
      platform: 'win32',
      env: { PATH: '' },
      exists: async () => false,
    }),
  ).toBeUndefined();
});
it.each([false, true])(
  'isolates OpenCode config/state and applies web=%s without shell/MCP/custom tools',
  (webAccess) => {
    const env = openCodeEnvironment({ ...req, webAccess }, 'C:/state');
    const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, string>;
      agent: Record<string, { permission?: Record<string, string> }>;
      formatter: boolean;
      lsp: boolean;
    };
    expect(cfg.permission).toMatchObject({
      '*': 'deny',
      read: 'ask',
      edit: 'ask',
      bash: 'deny',
      task: 'deny',
      webfetch: 'deny',
      websearch: webAccess ? 'allow' : 'deny',
    });
    expect(cfg.agent.agenthq!.permission).toEqual(cfg.permission);
    expect(cfg.formatter).toBe(false);
    expect(cfg.lsp).toBe(false);
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_PURE).toBe('1');
    expect(env.XDG_DATA_HOME).toBe('C:/state/data');
    expect(env.OPENCODE_TEST_HOME).toBe('C:/state/home');
  },
);
it('requires correlated concrete tool paths, confines reads canonically, and preserves write protections', async () => {
  const canonical = async (p: string) => p;
  const read = { toolCallId: 'r', kind: 'read', rawInput: {} };
  const cached = {
    toolCallId: 'r',
    kind: 'read',
    rawInput: { filePath: req.cwd + '/ok.md' },
  };
  expect(await approveOpenCode(req, read, undefined, canonical)).toBe(false);
  expect(await approveOpenCode(req, read, cached, canonical)).toBe(true);
  for (const filePath of [
    'C:/other/secret',
    '//server/share/x',
    '../../secret',
    'C:/Vault/HQ/Work-other/a',
  ])
    expect(
      await approveOpenCode(
        req,
        read,
        { ...cached, rawInput: { filePath } },
        canonical,
      ),
    ).toBe(false);
  expect(
    await approveOpenCode(req, read, cached, async () => 'C:/outside/secret'),
  ).toBe(false);
  expect(
    await approveOpenCode(
      req,
      read,
      { ...cached, rawInput: { filePath: 'relative.md' } },
      canonical,
    ),
  ).toBe(true);
  expect(
    await approveOpenCode(
      req,
      read,
      { ...cached, rawInput: { filePath: req.cwd + '/sub/file.md' } },
      async (p) =>
        p.replace(/\\/g, '/').endsWith('/sub/AGENTS.md')
          ? 'C:/outside/secret'
          : p,
    ),
  ).toBe(false);
  const edit = {
    toolCallId: 'w',
    kind: 'edit',
    rawInput: { filepath: req.cwd + '/ok.md' },
    content: [
      { type: 'diff', path: req.cwd + '/ok.md', oldText: null, newText: 'ok' },
    ],
  };
  expect(await approveOpenCode(req, edit, undefined, canonical)).toBe(false);
  expect(
    await approveOpenCode(
      req,
      edit,
      { kind: 'edit', rawInput: { filePath: req.cwd + '/ok.md' } },
      canonical,
    ),
  ).toBe(true);
  expect(
    await approveOpenCode(
      { ...req, permission: 'read-only' },
      edit,
      { kind: 'edit', rawInput: { filePath: req.cwd + '/ok.md' } },
      canonical,
    ),
  ).toBe(false);
  for (const path of [
    'C:/Vault/HQ/Agents/a.md',
    'C:/Vault/HQ/Tasks/a.md',
    'C:/Vault/HQ/Activity/a.md',
    'C:/Vault/.obsidian/x',
    'D:/unlisted/x',
  ])
    expect(
      await approveOpenCode(
        { ...req, extraDirs: ['C:/Vault', 'D:/project'] },
        {
          ...edit,
          rawInput: { filepath: path },
          content: [
            { type: 'diff', path, oldText: null, newText: 'not allowed' },
          ],
        },
        { kind: 'edit', rawInput: { filePath: path } },
        canonical,
      ),
    ).toBe(false);
  expect(
    await approveOpenCode(
      { ...req, readDirs: ['C:/Vault'] },
      read,
      { ...cached, rawInput: { filePath: 'C:/Vault/Notes/a.md' } },
      canonical,
    ),
  ).toBe(true);
  expect(
    await approveOpenCode(
      req,
      { kind: 'execute', rawInput: { command: 'echo bad' } },
      undefined,
      canonical,
    ),
  ).toBe(false);
});
