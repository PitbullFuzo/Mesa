import { describe, expect, it } from 'vitest';
import {
  graphAiCandidates,
  graphAiPrompt,
  graphAiSection,
  parseGraphAiReply,
  runGraphAiPass,
  stripFrontmatter,
  verifyGraphAiReply,
  type GraphAiResult,
} from '../src/core/graphAi';
import { analyseLinkGraph, buildLinkGraph } from '../src/core/graphMap';
import type { VaultFile } from '../src/core/vaultMap';

const note = {
  path: 'Ideas/quiet.md',
  text: 'Remember the Lisbon tram route. Ask Ana about the tax form.',
};
const paths = new Set(['Ideas/quiet.md', 'Notes/lisbon.md', 'Notes/tax.md']);

describe('reading the model reply', () => {
  it('finds the JSON inside a reply that also has prose', () => {
    const reply = parseGraphAiReply(
      'Here you go:\n{"concepts":["Lisbon tram"],"related":[{"path":"Notes/lisbon.md","phrase":"Lisbon tram"}]}\nThanks',
    );
    expect(reply).toEqual({
      concepts: ['Lisbon tram'],
      related: [{ path: 'Notes/lisbon.md', phrase: 'Lisbon tram' }],
    });
  });

  it('rejects anything that is not the expected shape', () => {
    expect(parseGraphAiReply('no json here')).toBeNull();
    expect(parseGraphAiReply('{"concepts": "not a list"}')).toBeNull();
    expect(parseGraphAiReply('{"concepts": [')).toBeNull();
  });

  it('caps the number of concepts and related notes', () => {
    const many = Array.from({ length: 9 }, (_, index) => `c${index}`);
    expect(parseGraphAiReply(JSON.stringify({ concepts: many }))).toBeNull();
  });
});

describe('checking each suggestion', () => {
  it('keeps a concept and a related note only when the note really says so', () => {
    const result = verifyGraphAiReply(
      note,
      {
        concepts: ['tram route', 'quantum gardening'],
        related: [
          { path: 'Notes/lisbon.md', phrase: 'Lisbon tram' },
          { path: 'Notes/missing.md', phrase: 'Lisbon tram' },
          { path: 'Notes/tax.md', phrase: 'a phrase that is not there' },
          { path: 'Ideas/quiet.md', phrase: 'tram route' },
        ],
      },
      paths,
    );
    expect(result.concepts).toEqual(['tram route']);
    expect(result.related).toEqual([
      { path: 'Notes/lisbon.md', phrase: 'Lisbon tram' },
    ]);
    expect(result.dropped).toBe(4);
  });

  it('matches phrases regardless of case and spacing', () => {
    const result = verifyGraphAiReply(
      note,
      { concepts: ['  TAX   form '], related: [] },
      paths,
    );
    expect(result.concepts).toEqual(['TAX   form']);
  });

  it('strips link brackets and backticks so a phrase cannot add a wikilink', () => {
    const result = verifyGraphAiReply(
      { path: 'Ideas/quiet.md', text: 'See [[Lisbon]] for the tram.' },
      { concepts: ['[[Lisbon]]'], related: [] },
      paths,
    );
    expect(result.concepts).toEqual(['Lisbon']);
    expect(
      graphAiSection(
        new Map([['Ideas/quiet.md', { mtime: 1, ...result }]]),
        { checked: 1, costUsd: 0, dropped: 0 },
        new Set(['Ideas/quiet.md']),
      ).join('\n'),
    ).not.toContain('[[');
  });
});

describe('which notes the pass reads', () => {
  const files: VaultFile[] = [
    { path: 'Notes/hub.md', mtime: 1, incomingLinks: 0 },
    { path: 'Notes/spoke.md', mtime: 2, incomingLinks: 0 },
    { path: 'Notes/third.md', mtime: 5, incomingLinks: 0 },
    { path: 'Ideas/quiet.md', mtime: 3, incomingLinks: 0 },
    { path: 'Misc/other.md', mtime: 4, incomingLinks: 0 },
  ];
  // A triangle: each of the three has two links, so none of them is a low-link candidate.
  const links = {
    'Notes/hub.md': { 'Notes/spoke.md': 1, 'Notes/third.md': 1 },
    'Notes/spoke.md': { 'Notes/third.md': 1 },
  };
  const analysis = analyseLinkGraph(
    buildLinkGraph(files, links, 'Mesa', '.obsidian'),
  );
  const mtimes = new Map(files.map((file) => [file.path, file.mtime]));

  it('takes only low-link notes, in path order', () => {
    expect(graphAiCandidates(analysis, mtimes, new Map())).toEqual([
      { path: 'Ideas/quiet.md', mtime: 3 },
      { path: 'Misc/other.md', mtime: 4 },
    ]);
  });

  it('does not read a note again until it changes', () => {
    const done = new Map<string, GraphAiResult>([
      ['Ideas/quiet.md', { mtime: 3, concepts: [], related: [], dropped: 0 }],
    ]);
    expect(graphAiCandidates(analysis, mtimes, done)).toEqual([
      { path: 'Misc/other.md', mtime: 4 },
    ]);
    const changed = new Map(mtimes).set('Ideas/quiet.md', 9);
    expect(
      graphAiCandidates(analysis, changed, done).map((c) => c.path),
    ).toContain('Ideas/quiet.md');
  });
});

describe('running the pass', () => {
  const candidates = [{ path: 'Ideas/quiet.md', mtime: 3 }];

  it('records a verified result and sums the cost', async () => {
    const done = new Map<string, GraphAiResult>();
    const result = await runGraphAiPass(candidates, paths, done, {
      readNote: async () => note.text,
      ask: async () => ({
        text: '{"concepts":["tram route"],"related":[]}',
        costUsd: 0.002,
        isError: false,
      }),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      checked: 1,
      failed: 0,
      dropped: 0,
      costUsd: 0.002,
    });
    expect(done.get('Ideas/quiet.md')).toMatchObject({
      mtime: 3,
      concepts: ['tram route'],
    });
  });

  it('records a bad reply at its modified time, so it is not retried every rebuild', async () => {
    const done = new Map<string, GraphAiResult>();
    const result = await runGraphAiPass(candidates, paths, done, {
      readNote: async () => note.text,
      ask: async () => ({
        text: 'sorry, no json',
        costUsd: 0.001,
        isError: false,
      }),
      signal: new AbortController().signal,
    });
    expect(result.failed).toBe(1);
    expect(done.get('Ideas/quiet.md')).toMatchObject({
      mtime: 3,
      concepts: [],
      related: [],
    });
  });

  it('stops with "no runtime" when no model is available', async () => {
    const result = await runGraphAiPass(candidates, paths, new Map(), {
      readNote: async () => note.text,
      ask: async () => null,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ checked: 0, skipped: 'no runtime' });
  });

  it('does not start another call once it is stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await runGraphAiPass(candidates, paths, new Map(), {
      readNote: async () => note.text,
      ask: async () => {
        calls += 1;
        return { text: '{}', costUsd: 0, isError: false };
      },
      signal: controller.signal,
    });
    expect(calls).toBe(0);
  });

  it('sends the note text and real paths in the prompt, and strips frontmatter', () => {
    const prompt = graphAiPrompt(note, [...paths]);
    expect(prompt).toContain('Ideas/quiet.md');
    expect(prompt).toContain('Notes/lisbon.md');
    expect(prompt).toContain(note.text);
    expect(stripFrontmatter('---\nagenthq: x\n---\nBody')).toBe('Body');
  });
});

describe('the map section', () => {
  it('says how it was checked and what was dropped, with the privacy note', () => {
    const section = graphAiSection(
      new Map([
        [
          'Ideas/quiet.md',
          { mtime: 3, concepts: ['tram route'], related: [], dropped: 2 },
        ],
      ]),
      { checked: 3, costUsd: 0.0123, dropped: 2 },
      new Set(['Ideas/quiet.md']),
    ).join('\n');
    expect(section).toContain('$0.0123');
    expect(section).toContain(
      "Free models' providers may keep or train on what they read.",
    );
    expect(section).toContain('`Ideas/quiet.md`: tram route');
  });
});
