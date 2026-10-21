import { describe, expect, it } from 'vitest';
import { parseAgentNotes, type NoteDocument } from '../src/core/notes';
import { DEFAULT_RUNTIME_ID } from '../src/core/runtimes/ids';

function note(
  id: string,
  overrides: Record<string, unknown> = {},
): NoteDocument {
  return {
    path: `Team/Agents/${id}.md`,
    name: id,
    body: `Instructions for ${id}`,
    frontmatter: {
      agenthq: 'agent',
      id,
      role: 'Role',
      runtime: DEFAULT_RUNTIME_ID,
      permission: 'read-only',
      reportsTo: null,
      verifier: null,
      group: null,
      model: null,
      workdir: null,
      skills: [],
      ...overrides,
    },
  };
}
const resolve = (link: string) =>
  ({
    CEO: 'Team/Agents/chief.md',
    Reviewer: 'Team/Agents/reviewer.md',
    guidelines: 'Team/Skills/guidelines.md',
  })[link] ?? null;

describe('agent note parsing', () => {
  it('loads full-permission notes with an actionable warning without changing the note', () => {
    const notes = [note('worker', { permission: 'full' })];
    const raw = structuredClone(notes);
    const result = parseAgentNotes(notes, resolve);
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents[0]?.warnings).toContain(
      'Full permission is not available — choose edit or read-only',
    );
    expect(notes).toEqual(raw);
  });
  it('drops missing skills and resolver failures while keeping valid skills', () => {
    const notes = [
      note('worker', {
        skills: ['[[Deleted skill]]', '[[guidelines]]', '[[Throws]]'],
      }),
    ];
    const raw = structuredClone(notes);
    const result = parseAgentNotes(notes, (link) => {
      if (link === 'Throws') throw new Error('Cache unavailable');
      return resolve(link);
    });
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.skills).toEqual(['Team/Skills/guidelines.md']);
    expect(result.agents[0]?.warnings).toEqual([
      'Skill [[Deleted skill]] is missing or invalid',
      'Skill [[Throws]] is missing or invalid',
    ]);
    expect(notes).toEqual(raw);
  });
  it('loads missing managers and verifiers with warnings including the original links', () => {
    const result = parseAgentNotes(
      [
        note('worker', {
          reportsTo: '[[Missing#Plan|Lead]]',
          verifier: '[[Missing verifier]]',
        }),
      ],
      () => null,
    );
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents[0]).toMatchObject({
      reportsTo: null,
      verifier: null,
      warnings: [
        'Manager [[Missing#Plan|Lead]] is missing or invalid',
        'Verifier [[Missing verifier]] is missing or invalid',
      ],
    });
  });
  it('loads agents when manager and verifier resolvers throw', () => {
    const result = parseAgentNotes(
      [note('worker', { reportsTo: '[[CEO]]', verifier: '[[Reviewer]]' })],
      () => {
        throw new Error('Cache unavailable');
      },
    );
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents[0]).toMatchObject({
      reportsTo: null,
      verifier: null,
      warnings: [
        'Manager [[CEO]] is missing or invalid',
        'Verifier [[Reviewer]] is missing or invalid',
      ],
    });
  });
  it('rejects every duplicate id and warns agents referring to either duplicate', () => {
    const duplicate = {
      ...note('dupe'),
      name: 'Copy',
      path: 'Team/Agents/Copy.md',
    };
    const notes = [
      note('healthy'),
      note('dupe'),
      duplicate,
      note('worker', { reportsTo: '[[dupe]]', verifier: '[[Copy]]' }),
    ];
    const result = parseAgentNotes(notes, (link) => `Team/Agents/${link}.md`);
    expect(result.agents.map((a) => a.id)).toEqual(['healthy', 'worker']);
    expect(result.invalidAgents).toHaveLength(2);
    expect(result.invalidAgents.every((a) => /duplicate/i.test(a.reason))).toBe(
      true,
    );
    expect(result.agents[1]).toMatchObject({
      reportsTo: null,
      verifier: null,
      warnings: [
        'Manager [[dupe]] is missing or invalid',
        'Verifier [[Copy]] is missing or invalid',
      ],
    });
  });
  it('severs cycle members only, preserving healthy incoming reports and raw notes', () => {
    const notes = [
      note('healthy'),
      note('a', { reportsTo: '[[b]]' }),
      note('b', { reportsTo: '[[a]]' }),
      note('self', { reportsTo: '[[self]]' }),
      note('child', { reportsTo: '[[a]]', verifier: '[[b]]' }),
      note('grandchild', { reportsTo: '[[child]]' }),
    ];
    const raw = structuredClone(notes);
    const result = parseAgentNotes(notes, (link) => `Team/Agents/${link}.md`);
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents.map((a) => a.id)).toEqual([
      'healthy',
      'a',
      'b',
      'self',
      'child',
      'grandchild',
    ]);
    for (const id of ['a', 'b', 'self']) {
      const agent = result.agents.find((a) => a.id === id);
      expect(agent?.reportsTo).toBeNull();
      expect(agent?.warnings).toEqual(['Cycle in reportsTo links']);
    }
    expect(result.agents[4]).toMatchObject({
      reportsTo: 'a',
      verifier: 'b',
      warnings: [],
    });
    expect(result.agents[5]).toMatchObject({
      reportsTo: 'child',
      warnings: [],
    });
    expect(notes).toEqual(raw);
  });
  it('keeps Coder and Reviewer when CEO has malformed frontmatter without mutating notes', () => {
    const notes = [
      note('ceo', { permission: 'oops' }),
      note('coder', { reportsTo: '[[CEO]]' }),
      note('reviewer', { reportsTo: '[[CEO]]' }),
    ];
    const raw = structuredClone(notes);
    const result = parseAgentNotes(notes, () => 'Team/Agents/ceo.md');
    expect(result.invalidAgents).toHaveLength(1);
    expect(result.invalidAgents[0]?.name).toBe('ceo');
    expect(result.agents.map((a) => a.id)).toEqual(['coder', 'reviewer']);
    for (const agent of result.agents) {
      expect(agent.reportsTo).toBeNull();
      expect(agent.warnings).toEqual(['Manager [[CEO]] is missing or invalid']);
    }
    expect(notes).toEqual(raw);
  });
  it('resolves wiki paths to stable ids and skill paths, not note names', () => {
    const notes = [
      note('chief'),
      note('reviewer'),
      note('coder', {
        reportsTo: '[[CEO#Plan|Lead]]',
        verifier: '[[Reviewer]]',
        skills: ['[[guidelines]]'],
      }),
      {
        path: 'Team/Skills/guidelines.md',
        name: 'guidelines',
        frontmatter: {},
        body: 'Skill',
      },
    ];
    const calls: string[][] = [];
    const result = parseAgentNotes(notes, (link, source) => {
      calls.push([link, source]);
      return resolve(link);
    });
    expect(result.invalidAgents).toEqual([]);
    expect(result.agents[2]).toMatchObject({
      id: 'coder',
      name: 'coder',
      reportsTo: 'chief',
      verifier: 'reviewer',
      skills: ['Team/Skills/guidelines.md'],
      model: '',
      workdir: '',
      instructions: 'Instructions for coder',
      warnings: [],
    });
    expect(calls).toContainEqual(['CEO', 'Team/Agents/coder.md']);
    const renamed = notes.map((n) =>
      n.name === 'chief'
        ? { ...n, name: 'Director', path: 'Team/Agents/Director.md' }
        : n,
    );
    expect(
      parseAgentNotes(renamed, (link) =>
        link === 'CEO' ? 'Team/Agents/Director.md' : resolve(link),
      ).agents[2]?.reportsTo,
    ).toBe('chief');
  });
});
