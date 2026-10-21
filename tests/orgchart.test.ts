import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/model';
import {
  getDirectReports,
  getDepth,
  wouldCreateCycle,
  reparentAgent,
  removeAgent,
} from '../src/core/orgchart';

export function agent(id: string, reportsTo: string | null = null): Agent {
  return {
    id,
    name: id,
    path: `Obi-I/Agents/${id}.md`,
    role: '',
    reportsTo,
    group: null,
    runtime: 'test',
    model: '',
    permission: 'read-only',
    workdir: '',
    verifier: null,
    skills: [],
    instructions: '',
    warnings: [],
  };
}

describe('org chart', () => {
  const agents = [agent('a'), agent('b', 'a'), agent('c', 'b')];
  it('finds direct reports and depth by stable id', () => {
    expect(getDirectReports(agents, 'a').map((a) => a.id)).toEqual(['b']);
    expect(getDepth(agents, 'a')).toBe(0);
    expect(getDepth(agents, 'c')).toBe(2);
    expect(getDepth(agents, 'unknown')).toBe(0);
  });
  it('rejects self, two-agent and deeper cycles without mutating the list', () => {
    expect(wouldCreateCycle(agents, 'a', 'a')).toBe(true);
    expect(wouldCreateCycle(agents, 'a', 'b')).toBe(true);
    expect(wouldCreateCycle(agents, 'a', 'c')).toBe(true);
    expect(wouldCreateCycle(agents, 'c', 'a')).toBe(false);
    expect(wouldCreateCycle(agents, 'c', null)).toBe(false);
    expect(() => reparentAgent(agents, 'a', 'c')).toThrow(/loop|cycle/i);
    const changed = reparentAgent(agents, 'c', 'a');
    expect(changed[2]?.reportsTo).toBe('a');
    expect(agents[2]?.reportsTo).toBe('b');
    expect(() => reparentAgent(agents, 'missing', 'a')).toThrow();
    expect(() => reparentAgent(agents, 'c', 'missing')).toThrow();
  });
  it('deletes a manager and moves direct reports to its manager', () => {
    expect(removeAgent(agents, 'b').map((a) => [a.id, a.reportsTo])).toEqual([
      ['a', null],
      ['c', 'a'],
    ]);
    expect(removeAgent(agents, 'a')[0]?.reportsTo).toBeNull();
    expect(agents[2]?.reportsTo).toBe('b');
    expect(removeAgent(agents, 'missing')).toEqual(agents);
  });
});
