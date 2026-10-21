import { expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import { ChatService } from '../src/core/chat';
import { FakeRuntime } from '../src/core/runtimes/fake';
import { setupPatchSchema } from '../src/core/setup';
import { resolveWorkdir } from '../src/core/workdir';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import { approveAcpEdit } from '../src/core/runtimes/acpPolicy';
import type { RunRequest } from '../src/core/runtimes/types';
for (const vaultAccess of ['off', 'read', 'write'] as const)
  for (const webAccess of [false, true])
    for (const permission of ['read-only', 'edit'] as const) {
      it(`maps ${vaultAccess}/${webAccess}/${permission} to separate read/write roots and runtime tools`, async () => {
        const policy = await resolveWorkdir({
          agentId: 'a',
          workdir: '',
          vaultBasePath: 'C:/Vault',
          managedRoot: 'HQ',
          allowedFolders: [],
          vaultAccess,
        });
        const request: RunRequest = {
          ...policy,
          prompt: 'test',
          systemPrompt: '',
          sessionId: '11111111-1111-4111-8111-111111111111',
          resume: false,
          permission,
          webAccess,
        };
        expect(policy.readDirs.includes('C:/Vault')).toBe(
          vaultAccess === 'read',
        );
        expect(policy.extraDirs.includes('C:/Vault')).toBe(
          vaultAccess === 'write',
        );
        const args = buildRuntimeArgs(request, 'C:/system.txt');
        const tools = args[args.indexOf('--tools') + 1]!;
        expect(tools.includes('WebFetch')).toBe(webAccess);
        expect(tools.includes('WebSearch')).toBe(webAccess);
        const allows = args[args.indexOf('--allowedTools') + 1]!;
        expect(allows.split(',').includes('Edit')).toBe(false);
        expect(allows.split(',').includes('Write')).toBe(false);
        expect(allows.includes('Edit(//c/Vault/**)')).toBe(
          permission === 'edit' && vaultAccess === 'write',
        );
        if (vaultAccess !== 'off') expect(args).toContain('C:/Vault');
        for (const path of [
          'C:/Vault/Notes/a.md',
          'C:/Vault/HQ/Agents/a.md',
          'C:/outside/a.md',
        ]) {
          const allowed = await approveAcpEdit(
            request,
            {
              kind: 'edit',
              rawInput: { tool: 'write_file', arguments: { path } },
              content: [{ type: 'diff', path }],
            },
            async (p) => p,
          );
          expect(allowed, path).toBe(
            permission === 'edit' &&
              vaultAccess === 'write' &&
              path === 'C:/Vault/Notes/a.md',
          );
        }
      });
    }
it('allows listed outside projects, refuses ancestors and confines unlisted outside paths', async () => {
  const options = {
    agentId: 'a',
    workdir: 'D:/project/a',
    vaultBasePath: 'C:/Vault',
    managedRoot: 'HQ',
    allowedFolders: ['D:/project'],
  };
  const policy = await resolveWorkdir(options);
  expect(policy.extraDirs).toContain('D:/project');
  expect(policy.cwd).toBe('D:/project/a');
  const req: RunRequest = {
    ...policy,
    prompt: '',
    systemPrompt: '',
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    permission: 'edit',
  };
  expect(buildRuntimeArgs(req, 'C:/system.txt')).toContain('D:/project');
  for (const [path, expected] of [
    ['D:/project/a/ok.md', true],
    ['D:/other/no.md', false],
  ] as const)
    expect(
      await approveAcpEdit(
        req,
        {
          kind: 'edit',
          rawInput: { tool: 'write_file', arguments: { path } },
          content: [{ type: 'diff', path }],
        },
        async (p) => p,
      ),
    ).toBe(expected);
  await expect(
    resolveWorkdir({ ...options, workdir: 'D:/other/a' }),
  ).rejects.toThrow(/outside|allowed/);
  for (const allowedFolders of [
    ['C:/'],
    ['C:/Vault'],
    ['C:/Vault/HQ'],
    ['C:/Vault/.obsidian'],
    ['D:/project'],
    ['//server/share'],
  ]) {
    if (allowedFolders[0] === 'D:/project') continue;
    await expect(
      resolveWorkdir({ ...options, allowedFolders }),
    ).rejects.toThrow(/contains|protected|UNC/);
  }
});
it('defaults legacy agents to vault off/web on and persists explicit per-agent access settings', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Access');
  const frontmatter = store.notes.get('Mesa/Agents/Access.md')!
    .frontmatter as Record<string, unknown>;
  delete frontmatter.vaultAccess;
  delete frontmatter.webAccess;
  expect((await store.loadAgents()).agents[0]).toMatchObject({
    vaultAccess: 'off',
    webAccess: true,
  });
  for (const vaultAccess of ['off', 'read', 'write'] as const)
    for (const webAccess of [false, true]) {
      const patch = setupPatchSchema.parse({ vaultAccess, webAccess });
      await store.patchAgent(id, patch);
      expect((await store.loadAgents()).agents[0]).toMatchObject({
        vaultAccess,
        webAccess,
      });
    }
  expect(setupPatchSchema.safeParse({ vaultAccess: 'full' }).success).toBe(
    false,
  );
  expect(setupPatchSchema.safeParse({ webAccess: 'false' }).success).toBe(
    false,
  );
});
it('forwards saved access settings to chat and conversation-summary turns', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Access');
  await store.patchAgent(id, {
    runtime: 'fake',
    vaultAccess: 'read',
    webAccess: false,
  });
  const runtime = new FakeRuntime(() => [
    { type: 'done', text: 'ok', isError: false },
  ]);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ allowedFolders: [], maxParallelRuns: 1 }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
  });
  await service.initialize();
  await service.send(id, 'hello');
  await service.newConversation(id);
  expect(runtime.requests).toHaveLength(2);
  for (const request of runtime.requests) {
    expect(request.webAccess).toBe(false);
    expect(request.readDirs).toContain('/vault');
    expect(request.extraDirs).not.toContain('/vault');
  }
  await service.dispose();
});
