import { describe, expect, it } from 'vitest';
import { resolveWorkdir } from '../src/core/workdir';
import { loadSettings } from '../src/core/settings';
import { MemoryStore } from '../src/core/memoryStore';
import { initializeStarterTeam } from '../src/core/starter';

describe('workdir policy', () => {
  it('makes Attachments readable via add-dir but always denies edits and working inside it', async () => {
    const options = {
      agentId: 'a',
      workdir: '',
      vaultBasePath: 'C:/Vault',
      managedRoot: 'HQ',
      allowedFolders: [],
    };
    const policy = await resolveWorkdir(options);
    expect(policy.extraDirs).toContain('C:/Vault/HQ/Attachments');
    expect(policy.protectedPaths).toContain('C:/Vault/HQ/Attachments');
    const { buildRuntimeArgs } =
      await import('../src/core/runtimes/claudeCode');
    const args = buildRuntimeArgs(
      {
        ...policy,
        prompt: 'edit image',
        systemPrompt: '',
        sessionId: 'a05d12f5-5b75-4b92-8296-9c43288d8182',
        resume: false,
        permission: 'edit',
      },
      'C:/temp/system.txt',
    );
    expect(args).toContain('Edit(//c/Vault/HQ/Attachments)');
    expect(args).toContain('Edit(//c/Vault/HQ/Attachments/**)');
    expect(args[args.lastIndexOf('--add-dir') + 1]).toBe(
      'C:/Vault/HQ/Attachments',
    );
    await expect(
      resolveWorkdir({ ...options, workdir: 'HQ/Attachments' }),
    ).rejects.toThrow('protected');
  });
  it('allows the default starter workdir with fresh settings, but no other folders', async () => {
    const settings = loadSettings(undefined);
    expect(settings.allowedFolders).toEqual([]);
    const store = new MemoryStore(settings.agenthqFolder);
    await initializeStarterTeam(store, settings.agenthqFolder);
    const agent = (await store.loadAgents()).agents.find(
      (entry) => entry.id === 'coder',
    )!;
    expect(agent.workdir).toBe('');
    const options = {
      agentId: agent.id,
      workdir: agent.workdir,
      vaultBasePath: '/vault',
      managedRoot: settings.agenthqFolder,
      allowedFolders: settings.allowedFolders,
    };
    expect((await resolveWorkdir(options)).cwd).toBe('/vault/Obi-I/Work/coder');
    for (const workdir of ['Notes', 'Obi-I/Work-other', '../outside'])
      await expect(resolveWorkdir({ ...options, workdir })).rejects.toThrow(
        'allowed',
      );
    expect(settings.allowedFolders).toEqual([]);
  });
  it('refuses the host configuration directory as well as the default directory', async () => {
    await expect(
      resolveWorkdir({
        agentId: 'a',
        workdir: '.custom-config',
        vaultBasePath: '/vault',
        managedRoot: 'HQ',
        allowedFolders: ['/vault'],
        configDir: '.custom-config',
      }),
    ).rejects.toThrow('protected');
  });
  it('refuses listed ancestors rather than silently clamping them', async () => {
    await expect(
      resolveWorkdir({
        agentId: 'a',
        workdir: 'c:/Vault/Notes',
        vaultBasePath: 'C:/Vault',
        managedRoot: 'HQ',
        allowedFolders: ['C:/'],
      }),
    ).rejects.toThrow('contains the vault');
  });
  it('refuses protected lexical aliases and ambiguous Windows paths', async () => {
    const base = {
      agentId: 'a',
      vaultBasePath: 'C:/Vault',
      managedRoot: 'HQ',
      allowedFolders: ['C:/Vault', 'D:/outside'],
    };
    for (const workdir of [
      'C:relative',
      'C:/Vault/.obsidian./x',
      '//?/C:/Vault/Notes',
      'C:/Vault/Notes:stream',
    ]) {
      await expect(resolveWorkdir({ ...base, workdir })).rejects.toThrow(
        /ambiguous|unsupported/,
      );
    }
    await expect(
      resolveWorkdir({
        ...base,
        workdir: '.obsidian/link',
        resolvePath: async (path) =>
          path === 'C:/Vault/.obsidian/link' ? 'D:/outside' : path,
      }),
    ).rejects.toThrow('protected');
  });
  it('allows listed outside folders but refuses UNC paths', async () => {
    await expect(
      resolveWorkdir({
        agentId: 'a',
        vaultBasePath: '/vault',
        managedRoot: 'HQ',
        allowedFolders: ['/projects'],
        workdir: '/projects/a',
      }),
    ).resolves.toMatchObject({ cwd: '/projects/a' });
    await expect(
      resolveWorkdir({
        agentId: 'a',
        vaultBasePath: '//server/share/vault',
        managedRoot: 'HQ',
        allowedFolders: ['Notes'],
        workdir: '//SERVER/share/vault/Notes/a',
      }),
    ).rejects.toThrow('UNC');
    await expect(
      resolveWorkdir({
        agentId: 'a',
        vaultBasePath: '/vault',
        managedRoot: 'HQ',
        allowedFolders: [],
        workdir: 'HQ/Work-other/a',
      }),
    ).rejects.toThrow('allowed');
  });
  it('refuses traversal, prefix siblings, protected folders and symlink escapes', async () => {
    const base = {
      agentId: 'a',
      vaultBasePath: '/vault',
      managedRoot: 'HQ',
      allowedFolders: ['Notes'],
    };
    for (const workdir of [
      '../outside',
      'Notes-other',
      '.obsidian',
      'HQ/Agents',
      'HQ/Tasks',
      'HQ/Activity',
    ]) {
      await expect(resolveWorkdir({ ...base, workdir })).rejects.toThrow(
        /allowed|protected/,
      );
    }
    await expect(
      resolveWorkdir({
        ...base,
        workdir: 'Notes/link',
        resolvePath: async (path) =>
          path === '/vault/Notes/link' ? '/outside' : path,
      }),
    ).rejects.toThrow('allowed');
  });
  it('compares Windows segments case-insensitively and POSIX segments case-sensitively', async () => {
    expect(
      (
        await resolveWorkdir({
          agentId: 'a',
          vaultBasePath: 'C:/Vault',
          managedRoot: 'HQ',
          allowedFolders: ['notes'],
          workdir: 'C:\\VAULT\\NOTES\\x',
        })
      ).cwd,
    ).toBe('C:/VAULT/NOTES/x');
    await expect(
      resolveWorkdir({
        agentId: 'a',
        vaultBasePath: '/vault',
        managedRoot: 'HQ',
        allowedFolders: ['notes'],
        workdir: 'Notes/x',
      }),
    ).rejects.toThrow('allowed');
  });
  it.each([
    ['HQ/Work', 'D:/unlisted'],
    ['HQ/Attachments', 'D:/unlisted'],
    ['HQ/Work', 'C:/Vault'],
  ])(
    'does not turn an implicit %s symlink to %s into a broad grant',
    async (folder, target) => {
      await expect(
        resolveWorkdir({
          agentId: 'a',
          workdir: '',
          vaultBasePath: 'C:/Vault',
          managedRoot: 'HQ',
          allowedFolders: [],
          resolvePath: async (p) =>
            p.startsWith('C:/Vault/' + folder)
              ? p.replace('C:/Vault/' + folder, target)
              : p,
        }),
      ).rejects.toThrow('outside');
    },
  );
  it.each(['', 'D:/project/a'])(
    'rejects canonical UNC aliases for listed projects with cwd %s',
    async (workdir) => {
      await expect(
        resolveWorkdir({
          agentId: 'a',
          workdir,
          vaultBasePath: 'C:/Vault',
          managedRoot: 'HQ',
          allowedFolders: ['D:/project'],
          resolvePath: async (p) =>
            p.startsWith('D:/project')
              ? p.replace('D:/project', '//server/share')
              : p,
        }),
      ).rejects.toThrow('UNC');
    },
  );
  it('resolves the default work directory and protects managed records', async () => {
    const result = await resolveWorkdir({
      agentId: 'coder',
      workdir: '',
      vaultBasePath: 'C:\\Vault',
      managedRoot: 'Obi-I',
      allowedFolders: ['Obi-I/Work'],
    });
    expect(result.cwd).toBe('C:/Vault/Obi-I/Work/coder');
    expect(result.protectedPaths).toEqual([
      'C:/Vault/.obsidian',
      'C:/Vault/Obi-I/Agents',
      'C:/Vault/Obi-I/Skills',
      'C:/Vault/Obi-I/Chats',
      'C:/Vault/Obi-I/Tasks',
      'C:/Vault/Obi-I/Activity',
      'C:/Vault/Obi-I/Projects',
      'C:/Vault/Obi-I/Schedules',
      'C:/Vault/Obi-I/Attachments',
      'C:/Vault/Obi-I/Groups.md',
      'C:/Vault/Obi-I/Welcome.md',
      'C:/Vault/Obi-I/Guide.md',
      'C:/Vault/Obi-I/Vault map.md',
      'C:/Vault/Obi-I/Graph map.md',
      'C:/Vault/Obi-I/Graph overview.canvas',
    ]);
    expect(result.protectedPaths).not.toContain('C:/Vault/Obi-I/Work');
  });

  it('refuses a work folder inside Skills, Chats or a root note, and allows Work', async () => {
    for (const workdir of ['Obi-I/Skills/x', 'Obi-I/Chats', 'Obi-I/Groups.md'])
      await expect(
        resolveWorkdir({
          agentId: 'coder',
          workdir,
          vaultBasePath: 'C:\\Vault',
          managedRoot: 'Obi-I',
          allowedFolders: [],
        }),
      ).rejects.toThrow('protected');
    await expect(
      resolveWorkdir({
        agentId: 'coder',
        workdir: 'Obi-I/Work/coder/notes',
        vaultBasePath: 'C:\\Vault',
        managedRoot: 'Obi-I',
        allowedFolders: [],
      }),
    ).resolves.toMatchObject({ cwd: 'C:/Vault/Obi-I/Work/coder/notes' });
  });
});
