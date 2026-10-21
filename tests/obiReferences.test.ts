import { describe, expect, it } from 'vitest';
import type { Agent, Group, Skill } from '../src/core/model';
import type { Project } from '../src/core/projects';
import { parseObiProposals } from '../src/core/obi';

const agent = (id: string, name: string) =>
  ({
    id,
    name,
    role: 'Role',
    runtime: 'claude-code',
    permission: 'read-only',
    vaultAccess: 'read',
    webAccess: false,
    group: null,
    reportsTo: null,
    model: '',
    workdir: '',
    skills: [],
  }) as unknown as Agent;
const groups: Group[] = [{ id: 'core', name: 'Core team', color: '#7c3aed' }];
const skills: Skill[] = [
  {
    path: 'Mesa/Skills/karpathy-guidelines.md',
    name: 'karpathy-guidelines',
    body: '',
  },
];
const snapshot = {
  agents: [agent('ceo', 'CEO')],
  groups,
  projects: [] as Project[],
  schedules: [],
  skills,
};
const reply = (json: string) => '```agenthq-admin\n' + json + '\n```';

describe('Obi project actions: references', () => {
  it('reports an unknown skill back instead of proposing it', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createProject","name":"Sales X","skills":["sales-strategy"]}]}',
      ),
      snapshot,
    );
    expect(proposals).toEqual([]);
    expect(problems[0]).toBe(
      'Action 1 was not valid: No skill called “sales-strategy”.',
    );
  });

  it('reports an unknown team, agent or project the same way', () => {
    const team = parseObiProposals(
      reply(
        '{"actions":[{"type":"createProject","name":"A","teams":["Sales team"]}]}',
      ),
      snapshot,
    );
    const who = parseObiProposals(
      reply(
        '{"actions":[{"type":"createSchedule","name":"B","agent":"Nobody","message":"Hi.","rule":{"kind":"daily","time":"09:00"},"costCapUsd":0.25}]}',
      ),
      snapshot,
    );
    const what = parseObiProposals(
      reply('{"actions":[{"type":"updateProject","id":"Ghost","goal":"x"}]}'),
      snapshot,
    );
    expect(team.problems[0]).toContain('No team called “Sales team”');
    expect(who.problems[0]).toContain('No agent called “Nobody”');
    expect(what.problems[0]).toContain('No project called “Ghost”');
  });
});
