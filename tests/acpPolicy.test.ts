import { expect, it } from 'vitest';
import { approveAcpEdit } from '../src/core/runtimes/acpPolicy';
import type { RunRequest } from '../src/core/runtimes/types';
const request: RunRequest = {
  prompt: '',
  systemPrompt: '',
  cwd: 'C:/Vault/HQ/Work/a',
  extraDirs: ['C:/Vault/HQ/Work', 'C:/Vault/HQ/Attachments'],
  protectedPaths: [
    'C:/Vault/.obsidian',
    'C:/Vault/HQ/Agents',
    'C:/Vault/HQ/Tasks',
    'C:/Vault/HQ/Activity',
    'C:/Vault/HQ/Attachments',
  ],
  permission: 'edit',
  sessionId: 'a',
  resume: false,
};
const proposal = (path: string) => ({
  kind: 'edit',
  rawInput: { tool: 'write_file', arguments: { path, content: 'ok' } },
  content: [{ type: 'diff', path, oldText: null, newText: 'ok' }],
});
it('allows only mapped edits inside allowed folders and denies protected paths', async () => {
  expect(
    await approveAcpEdit(
      request,
      proposal('C:/Vault/HQ/Work/a/ok.txt'),
      async (p) => p,
    ),
  ).toBe(true);
  for (const path of [
    ...request.protectedPaths!,
    'C:/other',
    'C:/Vault/HQ/Work-other/no.txt',
    'C:/Vault/HQ/Work/a/file.txt:ads',
    '~/outside.txt',
    '$HOME/outside.txt',
    '%USERPROFILE%/outside.txt',
    'C:/Vault/HQ/Work/a/../.. /no',
  ])
    expect(await approveAcpEdit(request, proposal(path), async (p) => p)).toBe(
      false,
    );
  expect(
    await approveAcpEdit(
      { ...request, permission: 'read-only' },
      proposal('ok.txt'),
      async (p) => p,
    ),
  ).toBe(false);
});
it('fails closed on unknown/multi-path requests and canonical symlink escapes', async () => {
  for (const payload of [
    {},
    { ...proposal('ok.txt'), kind: 'execute' },
    {
      ...proposal('ok.txt'),
      content: [{ type: 'diff', path: 'C:/Vault/HQ/Agents/no.md' }],
    },
    {
      ...proposal('ok.txt'),
      rawInput: {
        tool: 'patch',
        arguments: { mode: 'patch', patch: 'opaque' },
      },
    },
  ])
    expect(await approveAcpEdit(request, payload, async (p) => p)).toBe(false);
  expect(
    await approveAcpEdit(
      request,
      proposal('link/ok.txt'),
      async () => 'C:/outside/ok.txt',
    ),
  ).toBe(false);
});
