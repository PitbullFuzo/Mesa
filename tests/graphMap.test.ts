import { describe, expect, it, vi } from 'vitest';
import { wordCount } from '../src/core/memory';
import { MemoryStore } from '../src/core/memoryStore';
import {
  analyseLinkGraph,
  buildLinkGraph,
  GRAPH_MAP_LIMITS,
  renderGraphMap,
  syncGraphMap,
} from '../src/core/graphMap';
import {
  GRAPH_MAP_NAME,
  incomingLinkCounts,
  renderVaultMap,
  type VaultFile,
} from '../src/core/vaultMap';
import { loadSettings } from '../src/core/settings';

/** Builds the searchable file list the way the vault index does: incoming links come from the same link data. */
function vault(
  paths: string[],
  links: Record<string, Record<string, number>>,
): VaultFile[] {
  const incoming = incomingLinkCounts(links, 'Obi-I', '.obsidian');
  return paths.map((path, index) => ({
    path,
    mtime: index + 1,
    incomingLinks: incoming.get(path) ?? 0,
  }));
}

/** Two triangles (Notes/a1-a3 and Ideas/b1-b3) joined by one link, plus one note with no links. */
const sample = () => {
  const paths = [
    'Notes/a1.md',
    'Notes/a2.md',
    'Notes/a3.md',
    'Ideas/b1.md',
    'Ideas/b2.md',
    'Ideas/b3.md',
    'Misc/lonely.md',
    'Obi-I/Work/x.md',
  ];
  const links = {
    'Notes/a1.md': { 'Notes/a2.md': 1, 'Notes/a3.md': 1 },
    'Notes/a2.md': { 'Notes/a3.md': 1 },
    'Notes/a3.md': { 'Ideas/b1.md': 1 },
    'Ideas/b1.md': { 'Ideas/b2.md': 1, 'Ideas/b3.md': 1 },
    'Ideas/b2.md': { 'Ideas/b3.md': 1 },
    // Obi-I's own notes link into the vault; those links must not count.
    'Obi-I/Work/x.md': { 'Notes/a1.md': 1 },
  };
  return { files: vault(paths, links), links };
};

describe('the link graph', () => {
  it('leaves out Obi-I and the configuration folder, as the vault map does', () => {
    const { files, links } = sample();
    const graph = buildLinkGraph(files, links, 'Obi-I', '.obsidian');
    expect(graph.notes.map((note) => note.path)).not.toContain(
      'Obi-I/Work/x.md',
    );
    expect(graph.neighbours.get('Notes/a1.md')).toEqual(
      new Set(['Notes/a2.md', 'Notes/a3.md']),
    );
  });

  it('finds the hubs, the two clusters, the bridges and the orphans', () => {
    const { files, links } = sample();
    const analysis = analyseLinkGraph(
      buildLinkGraph(files, links, 'Obi-I', '.obsidian'),
    );
    // Two notes have two incoming links each; the tie goes to the smaller path.
    expect(analysis.hubs[0]).toEqual({ path: 'Ideas/b3.md', incomingLinks: 2 });
    expect(analysis.clusters).toHaveLength(2);
    const members = analysis.clusters.map((cluster) =>
      [...cluster.members].sort(),
    );
    expect(members).toContainEqual([
      'Ideas/b1.md',
      'Ideas/b2.md',
      'Ideas/b3.md',
    ]);
    expect(members).toContainEqual([
      'Notes/a1.md',
      'Notes/a2.md',
      'Notes/a3.md',
    ]);
    expect(analysis.orphans).toEqual(['Misc/lonely.md']);
    const bridgePaths = analysis.bridges.map((bridge) => bridge.path).sort();
    expect(bridgePaths).toEqual(['Ideas/b1.md', 'Notes/a3.md']);
    for (const bridge of analysis.bridges)
      expect(bridge.clusters).toEqual([1, 2]);
  });

  it('names each cluster by its most connected note and counts the links between clusters once', () => {
    const { files, links } = sample();
    const analysis = analyseLinkGraph(
      buildLinkGraph(files, links, 'Obi-I', '.obsidian'),
    );
    const hubs = analysis.clusters.map((cluster) => cluster.hub).sort();
    expect(hubs).toEqual(['Ideas/b1.md', 'Notes/a3.md']);
    expect([...analysis.crossLinks.values()]).toEqual([1]);
  });

  it('gives the same result however the files and links are ordered', () => {
    const { files, links } = sample();
    const reversedLinks = Object.fromEntries(Object.entries(links).reverse());
    const a = renderGraphMap(
      analyseLinkGraph(buildLinkGraph(files, links, 'Obi-I', '.obsidian')),
    );
    const b = renderGraphMap(
      analyseLinkGraph(
        buildLinkGraph(
          [...files].reverse(),
          reversedLinks,
          'Obi-I',
          '.obsidian',
        ),
      ),
    );
    expect(b).toBe(a);
  });
});

describe('the graph map text', () => {
  it('uses plain backticked paths, never wikilinks', () => {
    const { files, links } = sample();
    const text = renderGraphMap(
      analyseLinkGraph(buildLinkGraph(files, links, 'Obi-I', '.obsidian')),
    );
    expect(text).toContain('`Ideas/b1.md`');
    expect(text).toContain('## Orphans (no links)');
    expect(text).not.toContain('[[');
  });

  it('stays within the size cap however large the vault is', () => {
    const paths: string[] = [];
    const links: Record<string, Record<string, number>> = {};
    for (let index = 0; index < 400; index++) {
      const a = `Pairs/p${index}-a.md`;
      const b = `Pairs/p${index}-b.md`;
      paths.push(a, b);
      links[a] = { [b]: 1 };
    }
    for (let index = 0; index < 100; index++) paths.push(`Lone/n${index}.md`);
    const text = renderGraphMap(
      analyseLinkGraph(
        buildLinkGraph(vault(paths, links), links, 'Obi-I', '.obsidian'),
      ),
    );
    expect(wordCount(text)).toBeLessThanOrEqual(GRAPH_MAP_LIMITS.maxWords + 10);
    expect(text).toContain('more clusters are not listed here');
    expect(text).toContain('and 70 more');
  });

  it('is written only when it changes', async () => {
    const { files, links } = sample();
    const body = renderGraphMap(
      analyseLinkGraph(buildLinkGraph(files, links, 'Obi-I', '.obsidian')),
    );
    const store = new MemoryStore('Obi-I');
    await syncGraphMap(store, 'Obi-I', body);
    expect(
      store.notes.get(`Obi-I/${GRAPH_MAP_NAME}`)?.frontmatter,
    ).toMatchObject({
      agenthq: 'graph-map',
    });
    const save = vi.spyOn(store, 'saveNote');
    await syncGraphMap(store, 'Obi-I', body);
    expect(save).not.toHaveBeenCalled();
    await syncGraphMap(store, 'Obi-I', body + 'changed\n');
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('the optional AI pass', () => {
  it('is off by default', () => {
    expect(loadSettings(null).graphAi).toBe(false);
    expect(loadSettings(null).graphAiModel).toBe('');
  });
});

describe('the map notes', () => {
  it('start with the do-not-delete callout, before the content', () => {
    const { files, links } = sample();
    const graph = renderGraphMap(
      analyseLinkGraph(buildLinkGraph(files, links, 'Obi-I', '.obsidian')),
    );
    expect(graph).toContain('> [!info] Built by Obi-I to save AI tokens');
    expect(graph.indexOf('[!info]')).toBeLessThan(graph.indexOf('## Hubs'));
    const vault = renderVaultMap(files, '', 'Obi-I', '.obsidian');
    expect(vault).toContain('> [!info] Built by Obi-I to save AI tokens');
    expect(vault).toContain('You can edit the "Purpose:" lines (vault map).');
    expect(graph).not.toContain('Purpose:');
  });

  it('a deleted map comes back on the next rebuild', async () => {
    const { files, links } = sample();
    const body = renderGraphMap(
      analyseLinkGraph(buildLinkGraph(files, links, 'Obi-I', '.obsidian')),
    );
    const store = new MemoryStore('Obi-I');
    await syncGraphMap(store, 'Obi-I', body);
    store.notes.delete(`Obi-I/${GRAPH_MAP_NAME}`);
    expect(store.notes.has(`Obi-I/${GRAPH_MAP_NAME}`)).toBe(false);
    await syncGraphMap(store, 'Obi-I', body);
    expect(store.notes.get(`Obi-I/${GRAPH_MAP_NAME}`)?.body).toBe(body);
  });
});
