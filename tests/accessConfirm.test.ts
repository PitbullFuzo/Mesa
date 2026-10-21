import { expect, it, vi, beforeEach } from 'vitest';
beforeEach(() => vi.clearAllMocks());
import type { App } from 'obsidian';
import { WorkspaceController } from '../src/obsidian/workspaceController';
import { MemoryStore } from '../src/core/memoryStore';
import { ChatService } from '../src/core/chat';
import { FakeRuntime } from '../src/core/runtimes/fake';
import { confirmAction } from '../src/obsidian/modals';
vi.mock('obsidian', () => ({ Notice: class {}, FileSystemAdapter: class {} }));
vi.mock('../src/obsidian/modals', () => ({
  confirmAction: vi.fn(),
  promptForName: vi.fn(),
}));
it('applies saved access policy before an immediate next chat send', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Immediate');
  await store.patchAgent(id, { runtime: 'fake' });
  const runtime = new FakeRuntime(() => [
    { type: 'done', text: 'ok', isError: false },
  ]);
  const chat = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ allowedFolders: [], maxParallelRuns: 1 }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
  });
  await chat.initialize();
  const controller = new WorkspaceController({} as App, () => {});
  await controller.initialize(store);
  controller.attachChat(chat);
  await controller.updateAgent(id, { vaultAccess: 'read', webAccess: false });
  await chat.send(id, 'immediate');
  expect(runtime.requests[0]).toMatchObject({
    webAccess: false,
    readDirs: ['/vault'],
  });
  await controller.updateAgent(id, { vaultAccess: 'off', webAccess: true });
  await chat.send(id, 'revoked');
  expect(runtime.requests[1]).toMatchObject({ webAccess: true, readDirs: [] });
  controller.dispose();
  await chat.dispose();
});
it('confirms browser opt-in, cancels atomically and refuses browser access after a broad-read/runtime change', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Web');
  const c = new WorkspaceController({} as App, () => {});
  await c.initialize(store);
  c.setBrowserStatus({ engine: 'playwright', available: true, hint: 'ready' });
  vi.mocked(confirmAction).mockResolvedValue(false);
  await expect(
    c.updateAgent(id, { canUseBrowser: true, role: 'bad' }),
  ).rejects.toThrow(/confirmed/);
  expect((await store.loadAgents()).agents[0]).toMatchObject({
    canUseBrowser: false,
    role: '',
  });
  vi.mocked(confirmAction).mockResolvedValue(true);
  await c.updateAgent(id, { canUseBrowser: true });
  expect((await store.loadAgents()).agents[0]?.canUseBrowser).toBe(true);
  await expect(
    c.updateAgent(id, { wholeComputerReadConfirmed: true }),
  ).rejects.toThrow(/whole-computer/);
  // Codex reads the whole computer: the browser then needs its own tick box too.
  await expect(
    c.updateAgent(id, { runtime: 'codex', wholeComputerReadConfirmed: true }),
  ).rejects.toThrow(/Tick/);
  await c.updateAgent(id, {
    runtime: 'codex',
    wholeComputerReadConfirmed: true,
    browserReadsConfirmed: true,
  });
  expect((await store.loadAgents()).agents[0]).toMatchObject({
    runtime: 'codex',
    canUseBrowser: true,
    browserReadsConfirmed: true,
  });
  await c.updateAgent(id, { canUseBrowser: false });
  c.dispose();
});
it('requires confirmation before vault write escalation, cancels the whole patch and persists only after approval', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Access');
  const controller = new WorkspaceController({} as App, () => {});
  await controller.initialize(store);
  vi.mocked(confirmAction).mockResolvedValue(false);
  await expect(
    controller.updateAgent(id, { vaultAccess: 'write', role: 'changed' }),
  ).rejects.toThrow('not confirmed');
  expect((await store.loadAgents()).agents[0]).toMatchObject({
    vaultAccess: 'off',
    role: '',
  });
  vi.mocked(confirmAction).mockResolvedValue(true);
  await controller.updateAgent(id, { vaultAccess: 'write', webAccess: false });
  expect((await store.loadAgents()).agents[0]).toMatchObject({
    vaultAccess: 'write',
    webAccess: false,
  });
  expect(confirmAction).toHaveBeenCalledTimes(2);
  await controller.updateAgent(id, { vaultAccess: 'read' });
  expect(confirmAction).toHaveBeenCalledTimes(2);
  controller.dispose();
});
it('defaults web off on whole-computer consent, but permits a later deliberate web opt-in', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Whole');
  const c = new WorkspaceController({} as App, () => {});
  await c.initialize(store);
  vi.mocked(confirmAction).mockResolvedValue(true);
  await c.updateAgent(id, {
    runtime: 'codex',
    wholeComputerReadConfirmed: true,
  });
  expect((await store.loadAgents()).agents[0]?.webAccess).toBe(false);
  await c.updateAgent(id, { webAccess: true });
  expect((await store.loadAgents()).agents[0]?.webAccess).toBe(true);
  c.dispose();
});
it('requires a separate explicit confirmation for whole-computer reads and supports revocation', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Risk');
  const c = new WorkspaceController({} as App, () => {});
  await c.initialize(store);
  vi.mocked(confirmAction).mockResolvedValue(false);
  await expect(
    c.updateAgent(id, { runtime: 'codex', wholeComputerReadConfirmed: true }),
  ).rejects.toThrow(/not confirmed/);
  expect((await store.loadAgents()).agents[0]?.wholeComputerReadConfirmed).toBe(
    false,
  );
  vi.mocked(confirmAction).mockResolvedValue(true);
  await c.updateAgent(id, {
    runtime: 'codex',
    wholeComputerReadConfirmed: true,
  });
  expect((await store.loadAgents()).agents[0]?.wholeComputerReadConfirmed).toBe(
    true,
  );
  await c.updateAgent(id, { wholeComputerReadConfirmed: false });
  expect((await store.loadAgents()).agents[0]?.wholeComputerReadConfirmed).toBe(
    false,
  );
  c.dispose();
});
it('cannot pre-seed consent on another runtime and bypass the Codex transition confirmation', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Transition');
  const c = new WorkspaceController({} as App, () => {});
  await c.initialize(store);
  await c.updateAgent(id, { wholeComputerReadConfirmed: true });
  vi.mocked(confirmAction).mockResolvedValue(false);
  await expect(c.updateAgent(id, { runtime: 'codex' })).rejects.toThrow(
    /not confirmed/,
  );
  expect((await store.loadAgents()).agents[0]?.runtime).not.toBe('codex');
  c.dispose();
});
