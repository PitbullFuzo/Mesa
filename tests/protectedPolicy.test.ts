import { describe, expect, it } from 'vitest';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import { buildCodexArgs } from '../src/core/runtimes/codex';
import { approveAcpEdit } from '../src/core/runtimes/acpPolicy';
import { runtimeProtectedPaths } from '../src/core/runtimes/registry';
import { protectedAgentHqPaths } from '../src/core/protectedFolders';
import type { RunRequest } from '../src/core/runtimes/types';

const SESSION = '11111111-1111-4111-8111-111111111111';
const WORK = 'C:/Vault/Mesa/Work/coder';
const protectedPaths = [
  'C:/Vault/.obsidian',
  ...protectedAgentHqPaths('Mesa').map((entry) => `C:/Vault/${entry}`),
];
const BLOCKED = [
  'C:/Vault/Mesa/Skills/x.md',
  'C:/Vault/Mesa/Chats/x.md',
  'C:/Vault/Mesa/Groups.md',
  'C:/Vault/Mesa/Welcome.md',
];
const ALLOWED = `${WORK}/ok.txt`;

describe('one protected list for every runtime', () => {
  it('protects every Mesa folder except Work, and the root notes', () => {
    expect(protectedAgentHqPaths('Mesa')).toEqual(
      expect.arrayContaining([
        'Mesa/Skills',
        'Mesa/Chats',
        'Mesa/Attachments',
        'Mesa/Groups.md',
        'Mesa/Welcome.md',
      ]),
    );
    expect(protectedAgentHqPaths('Mesa')).not.toContain('Mesa/Work');
  });

  it('Claude Code denies edits to those paths and allows Work', () => {
    const args = buildRuntimeArgs(
      {
        prompt: 'continue',
        systemPrompt: 'system',
        cwd: WORK,
        sessionId: SESSION,
        resume: false,
        permission: 'edit',
        extraDirs: [WORK],
        protectedPaths,
      },
      'C:/system.txt',
    );
    // The allowed tools are one comma-joined argument, so match the joined command line.
    const line = args.join(' ');
    expect(line).toContain('--disallowedTools');
    expect(args).toContain('Edit(//c/Vault/Mesa/Skills/**)');
    expect(args).toContain('Edit(//c/Vault/Mesa/Chats/**)');
    expect(args).toContain('Edit(//c/Vault/Mesa/Groups.md)');
    expect(line).not.toContain('Edit(//c/Vault/Mesa/Work/**)');
    expect(line).toContain('Edit(//c/Vault/Mesa/Work/coder/**)');
  });

  it('ACP runtimes (Hermes, OpenCode) refuse edits to those paths, even with the whole vault writable', async () => {
    const proposal = (path: string) => ({
      kind: 'edit',
      rawInput: { tool: 'write_file', arguments: { path, content: 'ok' } },
      content: [{ type: 'diff', path, oldText: null, newText: 'ok' }],
    });
    const request = (extraDirs: string[]): RunRequest => ({
      prompt: '',
      systemPrompt: '',
      cwd: WORK,
      extraDirs,
      protectedPaths,
      permission: 'edit',
      sessionId: 'a',
      resume: false,
    });
    for (const extra of [[WORK], ['C:/Vault']])
      for (const path of BLOCKED)
        expect(
          await approveAcpEdit(request(extra), proposal(path), async (p) => p),
        ).toBe(false);
    expect(
      await approveAcpEdit(request([WORK]), proposal(ALLOWED), async (p) => p),
    ).toBe(true);
  });

  it('Codex has Work as its only writable root, and refuses a writable root inside protected folders', () => {
    const codex: RunRequest = {
      prompt: 'continue',
      systemPrompt: 'system',
      sessionId: SESSION,
      resume: false,
      permission: 'edit',
      wholeComputerReadConfirmed: true,
      protectedPaths,
      cwd: WORK,
      extraDirs: ['C:/Vault/Mesa/Work', 'C:/Vault/Mesa/Attachments'],
    };
    const args = buildCodexArgs(codex);
    expect(args).toContain('workspace-write');
    expect(args).toContain(WORK);
    expect(args).not.toContain('C:/Vault/Mesa/Attachments');
    expect(() => buildCodexArgs({ ...codex, extraDirs: ['C:/Vault'] })).toThrow(
      'writable root',
    );
    expect(() =>
      buildCodexArgs({ ...codex, cwd: 'C:/Vault/Mesa/Skills' }),
    ).toThrow('writable root');
  });

  it('the registry gives Claude the same list, plus the config folders', () => {
    const list = runtimeProtectedPaths({
      vaultBasePath: 'C:\\Vault',
      managedRoot: 'Mesa',
      configDir: '.obsidian',
      developerMode: false,
    }).map((entry) => entry.replace(/\\/g, '/'));
    expect(list).toEqual(
      expect.arrayContaining([
        'C:/Vault/.obsidian',
        'C:/Vault/Mesa/Skills',
        'C:/Vault/Mesa/Chats',
        'C:/Vault/Mesa/Groups.md',
      ]),
    );
    expect(list).not.toContain('C:/Vault/Mesa/Work');
  });
});
