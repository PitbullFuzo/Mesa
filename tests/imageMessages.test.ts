import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { FileSystemAdapter } from 'obsidian';
import { WorkspaceController } from '../src/obsidian/workspaceController';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';
vi.mock('obsidian', () => ({
  Notice: class {},
  FileSystemAdapter: class {
    getBasePath() {
      return 'C:/Vault';
    }
  },
}));
vi.mock('../src/obsidian/modals', () => ({
  confirmAction: vi.fn(),
  promptForName: vi.fn(),
}));
it('chat and broadcast deliver absolute image paths, persist embeds, and reload them', async () => {
  const store = new MemoryStore('HQ');
  const id = await store.createAgent('A');
  await store.patchAgent(id, { runtime: 'fake', permission: 'edit' });
  const runtime = new FakeRuntime(() => [
    { type: 'done', text: 'ok', isError: false },
  ]);
  const options = {
    store,
    adapters: [runtime],
    settings: () => ({ allowedFolders: [], maxParallelRuns: 2 }),
    vaultBasePath: 'C:/Vault',
    managedRoot: 'HQ',
  };
  const service = new ChatService(options);
  await service.initialize();
  expect(await store.exists('HQ/Attachments')).toBe(true);
  const controller = new WorkspaceController(
    { vault: { adapter: new FileSystemAdapter() } } as unknown as App,
    () => {},
  );
  await controller.initialize(store);
  controller.attachChat(service);
  const image = { path: 'HQ/Attachments/image-123.png', url: 'app://image' };
  await controller.sendMessage(id, 'Look', [image]);
  await controller.broadcast({ kind: 'agent', id }, 'Again', [image]);
  expect(runtime.requests).toHaveLength(2);
  for (const req of runtime.requests) {
    expect(req.prompt).toContain('C:/Vault/HQ/Attachments/image-123.png');
    expect(req.extraDirs).toContain('C:/Vault/HQ/Attachments');
    expect(req.protectedPaths).toContain('C:/Vault/HQ/Attachments');
  }
  const notes = await store.loadChats();
  expect(notes[0]!.body).not.toContain(
    'Image file (use the Read tool to view)',
  );
  expect(controller.getSnapshot().chat!.broadcast!.text).not.toContain(
    'Image file (use the Read tool to view)',
  );
  expect(service.getSnapshot().agents[id]!.messages[0]!.content).not.toContain(
    'C:/Vault',
  );
  expect(
    notes[0]!.body.match(/!\[\[HQ\/Attachments\/image-123.png\]\]/g),
  ).toHaveLength(2);
  await service.dispose();
  const reopened = new ChatService(options);
  await reopened.initialize();
  expect(reopened.getSnapshot().agents[id]!.messages[0]!.content).toContain(
    '![[HQ/Attachments/image-123.png]]',
  );
  await reopened.dispose();
  controller.dispose();
});
