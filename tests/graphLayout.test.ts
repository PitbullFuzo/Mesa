import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/model';
import { graphGroupFrame, graphLayoutPositions } from '../src/core/graphLayout';

function agent(id: string, group: string | null = null): Agent {
  return {
    id,
    name: id,
    path: `${id}.md`,
    role: '',
    reportsTo: null,
    group,
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

describe('absolute graph layout', () => {
  it('expands a group frame around unrestricted absolute member positions', () => {
    expect(
      graphGroupFrame({ x: 100, y: 100 }, [
        { x: -100, y: -200 },
        { x: 900, y: 800 },
      ]),
    ).toEqual({ position: { x: -132, y: -264 }, width: 1288, height: 1212 });
    expect(graphGroupFrame({ x: 20, y: 40 }, [])).toEqual({
      position: { x: 20, y: 40 },
      width: 320,
      height: 200,
    });
  });
  it('preserves saved absolute coordinates and places new members around the saved anchor', () => {
    const layout = {
      a: { x: -200, y: 900 },
      'group:team': { x: 1200, y: -80 },
    };
    const before = structuredClone(layout);
    const positions = graphLayoutPositions(
      [agent('a', 'team'), agent('b', 'team')],
      [{ id: 'team', name: 'Renamed team', color: 'red' }],
      layout,
    );
    expect(positions.a).toEqual(layout.a);
    expect(positions['group:team']).toEqual(layout['group:team']);
    expect(positions.b).toEqual({ x: 1488, y: -16 });
    positions.a!.x = 0;
    expect(layout).toEqual(before);
  });
  it('fills deterministic positions independent of collection order', () => {
    const agents = [agent('b', 'team'), agent('a', 'team'), agent('free')];
    const groups = [{ id: 'team', name: 'Team', color: '#123456' }];
    const positions = graphLayoutPositions(agents, groups, {});
    expect(Object.keys(positions).sort()).toEqual([
      'a',
      'b',
      'free',
      'group:team',
    ]);
    expect(positions).toEqual(
      graphLayoutPositions([...agents].reverse(), groups, {}),
    );
    expect(positions.a).not.toEqual(positions.b);
    expect(positions.a!.x).toBeGreaterThan(positions['group:team']!.x);
    expect(positions.a!.y).toBeGreaterThan(positions['group:team']!.y);
  });
});
