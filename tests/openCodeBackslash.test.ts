import { expect, it } from 'vitest';
import { approveOpenCode } from '../src/core/runtimes/openCode';
import type { RunRequest } from '../src/core/runtimes/types';

/** The same path as the model may write it on Windows: every slash a backslash. The folders Obi-I allows use slashes. */
const bs = (path: string) => path.replace(/\//g, '\\');

const req: RunRequest = {
  cwd: 'C:/Vault/HQ/Work/a',
  extraDirs: ['C:/Vault/HQ/Work', 'D:/project'],
  readDirs: [],
  protectedPaths: ['C:/Vault/.obsidian', 'C:/Vault/HQ/Agents'],
  permission: 'edit',
  sessionId: 'id',
  resume: false,
  prompt: '',
  systemPrompt: '',
};
const canonical = async (p: string) => p;
const editOf = (path: string, locationPath = path) => ({
  toolCallId: 'w',
  kind: 'edit',
  rawInput: { filepath: path },
  content: [{ type: 'diff', path, oldText: null, newText: 'ok' }],
  locations: [{ path: locationPath }],
});
const allowed = (path: string, call: unknown = editOf(path)) =>
  approveOpenCode(
    req,
    call,
    { kind: 'edit', rawInput: { filePath: path } },
    canonical,
  );

it('accepts backslashes and slashes for the same allowed Work folder', async () => {
  for (const path of [
    bs('C:/Vault/HQ/Work/a/note.md'),
    'C:/Vault/HQ/Work/a/note.md',
    'C:\\Vault/HQ\\Work/a\\note.md',
    bs('c:/vault/hq/work/a/note.md'),
    bs('sub/note.md'),
    bs('D:/project/src/x.ts'),
  ])
    expect(await allowed(path), path).toBe(true);
});

it('does not widen what is allowed when backslashes are used', async () => {
  for (const path of [
    bs('C:/Vault/HQ/Agents/a.md'),
    bs('C:/Vault/.obsidian/x'),
    bs('C:/Vault/HQ/Work-other/a.md'),
    bs('C:/Vault/HQ/Work/a/../../Agents/a.md'),
    bs('../../Agents/a.md'),
    '\\\\server\\share\\x',
    bs('D:/unlisted/x'),
  ])
    expect(await allowed(path), path).toBe(false);
});

it('still refuses a call whose own paths disagree', async () => {
  const path = bs('C:/Vault/HQ/Work/a/note.md');
  const other = bs('C:/Vault/HQ/Agents/a.md');
  const diffElsewhere = {
    ...editOf(path),
    content: [{ type: 'diff', path: other, oldText: null, newText: 'x' }],
  };
  expect(await allowed(path, diffElsewhere)).toBe(false);
  expect(await allowed(path, editOf(path, other))).toBe(false);
});
