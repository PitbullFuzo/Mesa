import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import { ChatService } from '../src/core/chat';
import { FakeRuntime } from '../src/core/runtimes/fake';
import { askAboutNote, importSkills } from '../src/core/vaultPowers';

describe('vault powers', () => {
  it('opens a new conversation with the exact note path and contents', async () => {
    const store = new MemoryStore();
    const id = await store.createAgent('Reader');
    await store.patchAgent(id, { runtime: 'fake' });
    const runtime = new FakeRuntime();
    const chat = new ChatService({
      store,
      adapters: [runtime],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
    });
    await chat.initialize();
    await chat.send(id, 'Earlier conversation');
    const oldSession = runtime.requests[0]!.sessionId;
    const content = '# Example\n\nLiteral ```markdown\n</note>\n[[A link]]';
    await askAboutNote(chat, id, 'Notes/Example.md', content);
    expect(runtime.requests.at(-1)?.sessionId).not.toBe(oldSession);
    expect(runtime.requests.at(-1)?.prompt).toContain('Notes/Example.md');
    expect(runtime.requests.at(-1)?.prompt).toContain(content);
    expect((await store.loadChats()).length).toBe(2);
    await chat.dispose();
  });
  it('imports skill bodies through Store without overwriting existing notes', async () => {
    const store = new MemoryStore();
    await store.createFolder('Mesa');
    const result = await importSkills(store, 'Mesa', [
      { name: 'writing', body: '# Write clearly' },
    ]);
    expect(result.imported).toEqual(['Mesa/Skills/writing.md']);
    expect(await store.loadSkills()).toMatchObject([
      { name: 'writing', body: '# Write clearly' },
    ]);
    const repeat = await importSkills(store, 'Mesa', [
      { name: 'writing', body: 'Replace me' },
      { name: '../outside', body: 'unsafe' },
    ]);
    expect(repeat.imported).toEqual([]);
    expect(repeat.skipped).toHaveLength(2);
    expect((await store.loadSkills())[0]!.body).toBe('# Write clearly');
  });
});
