import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RuntimeAdapter } from '../src/core/runtimes/types';
import { wordCount } from '../src/core/memory';
import {
  hasVaultAccess,
  incomingLinkCounts,
  isVaultSearchable,
  parsePurposes,
  passagesFor,
  renderVaultMap,
  syncVaultMap,
  VAULT_MAP_LIMITS,
  vaultMapInstruction,
  vaultSearchSection,
  type VaultFile,
} from '../src/core/vaultMap';

const files: VaultFile[] = [
  { path: 'Notes/alpha.md', mtime: 1, incomingLinks: 3 },
  { path: 'Notes/beta.md', mtime: 5, incomingLinks: 0 },
  { path: 'Projects/gamma.md', mtime: 2, incomingLinks: 1 },
  { path: 'Mesa/Agents/CEO.md', mtime: 9, incomingLinks: 9 },
  { path: '.obsidian/hidden.md', mtime: 9, incomingLinks: 9 },
];

describe('what the map and search cover', () => {
  it('leaves out Mesa and the configuration folder, but not a sibling that only starts the same way', () => {
    expect(isVaultSearchable('Mesa/Work/x.md', 'Mesa', '.obsidian')).toBe(
      false,
    );
    expect(isVaultSearchable('.obsidian/x.md', 'Mesa', '.obsidian')).toBe(
      false,
    );
    expect(isVaultSearchable('Mesa2/x.md', 'Mesa', '.obsidian')).toBe(true);
    expect(isVaultSearchable('Notes/a.md', 'Mesa', '.obsidian')).toBe(true);
  });

  it('agents with vault access get the map instruction; agents without it do not', () => {
    expect(hasVaultAccess({ vaultAccess: 'read' })).toBe(true);
    expect(hasVaultAccess({ vaultAccess: 'write' })).toBe(true);
    expect(hasVaultAccess({ vaultAccess: 'off' })).toBe(false);
    expect(vaultMapInstruction('Mesa')).toContain(
      "Read `Mesa/Vault map.md` and `Mesa/Graph map.md` first. Start from the hub or cluster that fits the task, then open only the notes you need; don't list or read the whole vault.",
    );
  });
});

describe('the vault map', () => {
  it('lists each folder with its count and its most linked titles, and skips Mesa', () => {
    const map = renderVaultMap(files, '', 'Mesa', '.obsidian');
    expect(map).toContain(
      '## Folder: Notes\nPurpose: (add a purpose)\nNotes: 2',
    );
    expect(map).toContain('## Folder: Projects');
    expect(map).not.toContain('## Folder: Mesa');
    expect(map).not.toContain('CEO');
    expect(map).not.toContain('hidden');
    // The most linked note comes first.
    expect(map.indexOf('`Notes/alpha.md`')).toBeLessThan(
      map.indexOf('`Notes/beta.md`'),
    );
  });

  it('lists notes as plain paths, never as wikilinks, so the map adds no backlinks in the graph', () => {
    const map = renderVaultMap(files, '', 'Mesa', '.obsidian');
    expect(map).not.toContain('[[');
    expect(map).toContain('`Projects/gamma.md`');
  });

  it('counts incoming links only from searchable notes, so the map cannot raise the notes it lists', () => {
    const counts = incomingLinkCounts(
      {
        'Mesa/Vault map.md': { 'Notes/alpha.md': 1, 'Projects/gamma.md': 1 },
        'Notes/beta.md': { 'Notes/alpha.md': 2 },
        '.obsidian/x.md': { 'Notes/alpha.md': 5 },
      },
      'Mesa',
      '.obsidian',
    );
    expect(counts.get('Notes/alpha.md')).toBe(2);
    expect(counts.get('Projects/gamma.md')).toBeUndefined();
  });

  it('is stable: the same vault gives the same map', () => {
    expect(renderVaultMap(files, '', 'Mesa', '.obsidian')).toBe(
      renderVaultMap(files, '', 'Mesa', '.obsidian'),
    );
  });

  it('keeps the purposes the owner wrote, and does not keep the placeholder', () => {
    const first = renderVaultMap(files, '', 'Mesa', '.obsidian');
    const edited = first.replace(
      'Purpose: (add a purpose)\nNotes: 2',
      'Purpose: Client notes\nNotes: 2',
    );
    expect(parsePurposes(edited).get('Notes')).toBe('Client notes');
    const rebuilt = renderVaultMap(files, edited, 'Mesa', '.obsidian');
    expect(rebuilt).toContain('## Folder: Notes\nPurpose: Client notes');
    expect(parsePurposes(first).size).toBe(0);
  });

  it('stays within its size cap, even for a very large vault', () => {
    const many: VaultFile[] = Array.from({ length: 400 }, (_, folder) =>
      Array.from({ length: 12 }, (_, note) => ({
        path: `Folder ${folder}/Note ${note} with some longer words here.md`,
        mtime: note,
        incomingLinks: note,
      })),
    ).flat();
    const map = renderVaultMap(many, '', 'Mesa', '.obsidian');
    expect(wordCount(map)).toBeLessThanOrEqual(VAULT_MAP_LIMITS.maxWords + 15);
    expect(map).toContain('more folders are not listed here');
  });

  it('writes the note only when its content changes', async () => {
    const store = new MemoryStore('Mesa');
    const save = vi.spyOn(store, 'saveNote');
    await syncVaultMap(store, 'Mesa', files, '.obsidian');
    expect(store.notes.get('Mesa/Vault map.md')?.body).toContain(
      '## Folder: Notes',
    );
    // The first write creates the note; the in-memory store creates through saveNote, so count from here.
    save.mockClear();
    await syncVaultMap(store, 'Mesa', files, '.obsidian');
    expect(save).not.toHaveBeenCalled();
    const changed = [
      ...files,
      { path: 'Notes/new.md', mtime: 7, incomingLinks: 0 },
    ];
    await syncVaultMap(store, 'Mesa', changed, '.obsidian');
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.notes.get('Mesa/Vault map.md')?.body).toContain('Notes: 3');
  });
});

describe('vault search', () => {
  it('splits a note into passages at paragraph breaks, without its frontmatter', () => {
    const text = `---\ntitle: Ignore me\n---\n\nFirst paragraph about tea.\n\nSecond paragraph about coffee.`;
    const passages = passagesFor('Notes/a.md', text, 5);
    expect(passages.map((passage) => passage.id)).toEqual([
      'Notes/a.md#0',
      'Notes/a.md#1',
    ]);
    expect(passages.map((passage) => passage.text).join(' ')).not.toContain(
      'Ignore me',
    );
  });

  it('the token cache shrinks after a note is deleted', () => {
    const cache = new Map<string, { text: string; tokens: string[] }>();
    const before = [
      { id: 'Notes/tea.md#0', text: 'Green tea brewing notes.' },
      { id: 'Notes/old.md#0', text: 'An old note that will be deleted.' },
    ];
    vaultSearchSection('green tea', before, 100, cache);
    expect(cache.size).toBe(2);
    vaultSearchSection('green tea', [before[0]!], 100, cache);
    expect([...cache.keys()]).toEqual(['Notes/tea.md#0']);
  });

  it('returns the best matching passage first, and stays within the word cap', () => {
    const passages = [
      {
        id: 'Notes/tea.md#0',
        text: 'Green tea brewing notes with temperature details.',
      },
      { id: 'Projects/bike.md#0', text: 'Bike service schedule for spring.' },
    ];
    const section = vaultSearchSection(
      'how do I brew green tea',
      passages,
      100,
      new Map(),
    );
    // Each passage is shown with its path, not a wikilink.
    expect(section).toContain('- `Notes/tea.md`: Green tea brewing notes');
    expect(section).not.toContain('[[');
    expect(section).not.toContain('bike');
    expect(
      vaultSearchSection('how do I brew green tea', passages, 3, new Map()),
    ).toBe('');
    expect(
      vaultSearchSection('quantum physics', passages, 100, new Map()),
    ).toBe('');
  });
});

describe('vault access in a run', () => {
  async function setup() {
    const store = new MemoryStore('Mesa');
    const reader = await store.createAgent('Reader');
    const plain = await store.createAgent('Plain');
    await store.patchAgent(reader, { runtime: 'fake', vaultAccess: 'read' });
    await store.patchAgent(plain, { runtime: 'fake', vaultAccess: 'off' });
    const fake = new FakeRuntime(
      (request) => [
        {
          type: 'done',
          text: `reply ${request.prompt}`,
          isError: false,
          costUsd: 0,
        },
      ],
      0,
    );
    const adapter: RuntimeAdapter = fake;
    const service = new ChatService({
      store,
      adapters: [adapter],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      memoryDelayMs: 60_000,
      vaultSnippets: async () => [
        {
          id: 'Notes/tea.md#0',
          text: 'Green tea brewing notes with temperature details.',
        },
      ],
    });
    await service.initialize();
    return { service, fake, reader, plain };
  }

  it('an agent with vault access sees the map instruction and the matching passages', async () => {
    const { service, fake, reader } = await setup();
    await service.send(reader, 'how do I brew green tea');
    const prompt = fake.requests.at(-1)!.systemPrompt;
    expect(prompt).toContain(
      'Read `Mesa/Vault map.md` and `Mesa/Graph map.md` first',
    );
    expect(prompt).toContain('Green tea brewing notes');
  });

  it('an agent without vault access gets neither the instruction nor any passage', async () => {
    const { service, fake, plain } = await setup();
    await service.send(plain, 'how do I brew green tea');
    const prompt = fake.requests.at(-1)!.systemPrompt;
    expect(prompt).not.toContain('Vault map.md');
    expect(prompt).not.toContain('Graph map');
    expect(prompt).not.toContain('Green tea brewing notes');
  });
});
