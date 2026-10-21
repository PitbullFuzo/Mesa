import { describe, expect, it, vi } from 'vitest';
import { appendActivityLine } from '../src/core/activity';
import {
  graphActivityLine,
  graphAiCandidates,
  loadGraphConcepts,
  parseGraphConcepts,
  runGraphAiPass,
  saveGraphConcepts,
  serialiseGraphConcepts,
  type GraphAiResult,
} from '../src/core/graphAi';
import { analyseLinkGraph, buildLinkGraph } from '../src/core/graphMap';
import { MemoryStore } from '../src/core/memoryStore';
import type { VaultFile } from '../src/core/vaultMap';

const files: VaultFile[] = [
  { path: 'Ideas/quiet.md', mtime: 3, incomingLinks: 0 },
  { path: 'Misc/other.md', mtime: 4, incomingLinks: 0 },
];
const analysis = analyseLinkGraph(
  buildLinkGraph(files, {}, 'Mesa', '.obsidian'),
);
const mtimes = new Map(files.map((file) => [file.path, file.mtime]));

const kept = (): Map<string, GraphAiResult> =>
  new Map([
    [
      'Ideas/quiet.md',
      { mtime: 3, concepts: ['tram route'], related: [], dropped: 1 },
    ],
  ]);

describe('keeping results across restarts', () => {
  it('round-trips the kept results and the running total', () => {
    const file = { totalCostUsd: 0.5, results: kept() };
    expect(parseGraphConcepts(serialiseGraphConcepts(file))).toEqual(file);
  });

  it('gives an empty file for missing or unreadable text, so the pass starts again', () => {
    expect(parseGraphConcepts(null)).toEqual({
      totalCostUsd: 0,
      results: new Map(),
    });
    expect(parseGraphConcepts('not json').results.size).toBe(0);
    const bad = parseGraphConcepts(
      '{"totalCostUsd":"x","results":{"a":{"mtime":"bad"}}}',
    );
    expect(bad.totalCostUsd).toBe(0);
    expect(bad.results.size).toBe(0);
  });

  it('survives a reload: a note is not read again while its modified time is unchanged', async () => {
    const store = new MemoryStore('Mesa');
    await saveGraphConcepts(store, 'Mesa', {
      totalCostUsd: 0.5,
      results: kept(),
    });
    const loaded = await loadGraphConcepts(store, 'Mesa');
    expect(loaded.totalCostUsd).toBe(0.5);

    // The restart: only the note that was never read is a candidate.
    expect(graphAiCandidates(analysis, mtimes, loaded.results)).toEqual([
      { path: 'Misc/other.md', mtime: 4 },
    ]);
    const ask = vi.fn(async () => ({ text: '{}', costUsd: 0, isError: false }));
    await runGraphAiPass(
      graphAiCandidates(analysis, mtimes, loaded.results),
      new Set(files.map((file) => file.path)),
      loaded.results,
      {
        readNote: async () => 'Some text.',
        ask,
        signal: new AbortController().signal,
      },
    );
    expect(ask).toHaveBeenCalledTimes(1);

    // A changed note is read again.
    const changed = new Map(mtimes).set('Ideas/quiet.md', 99);
    expect(
      graphAiCandidates(analysis, changed, loaded.results).map((c) => c.path),
    ).toContain('Ideas/quiet.md');
  });

  it('writes the kept file only when its text changed', async () => {
    const store = new MemoryStore('Mesa');
    const file = { totalCostUsd: 0.1, results: kept() };
    await saveGraphConcepts(store, 'Mesa', file);
    const write = vi.spyOn(store, 'writeText');
    await saveGraphConcepts(store, 'Mesa', file);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the spend in the Activity log', () => {
  it('writes one line per pass run with the notes read, the cost and the running total', async () => {
    const store = new MemoryStore('Mesa');
    const line = graphActivityLine(
      { checked: 2, failed: 0, dropped: 0, costUsd: 0.004, skipped: '' },
      0.0123,
    );
    await appendActivityLine(store, 'Mesa', line, new Date(2026, 9, 21, 9, 5));
    const text = [...store.notes.values()].map((note) => note.body).join('\n');
    expect(text).toContain(
      '- 09:05 Graph map AI concepts: 2 notes read, $0.0040 this rebuild, $0.0123 in total',
    );
  });

  it('says why a pass stopped early', () => {
    expect(
      graphActivityLine(
        {
          checked: 0,
          failed: 0,
          dropped: 0,
          costUsd: 0,
          skipped: 'no runtime',
        },
        0,
      ),
    ).toMatch(/stopped: no runtime$/);
  });
});
