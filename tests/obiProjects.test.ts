import { describe, expect, it, vi } from 'vitest';
import type { Agent, Group, Skill } from '../src/core/model';
import type { Project } from '../src/core/projects';
import type { Schedule } from '../src/core/schedules';
import {
  applyObiAction,
  obiPrompt,
  parseObiProposals,
  type ObiOps,
} from '../src/core/obi';

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    role: 'Role',
    runtime: 'claude-code',
    permission: 'read-only',
    vaultAccess: 'read',
    webAccess: false,
    group: 'core',
    reportsTo: null,
    model: '',
    workdir: '/private/work/tree',
    skills: [],
  } as unknown as Agent;
}
const groups: Group[] = [{ id: 'core', name: 'Core team', color: '#7c3aed' }];
const skills: Skill[] = [
  {
    path: 'Obi-I/Skills/sales.md',
    name: 'sales-playbook',
    body: 'Sell well.',
  },
];
const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'Sales',
    path: 'Obi-I/Projects/Sales.md',
    status: 'active',
    goal: '',
    teams: ['core'],
    agents: [],
    skills: [],
    archived: false,
    instructions: 'Increase sales.',
    contextLevels: {},
    costLimitUsd: 1,
    ...over,
  }) as Project;
const schedule = (over: Partial<Schedule> = {}): Schedule =>
  ({
    agentId: 'ceo',
    projectId: 'p1',
    rule: { kind: 'daily', time: '09:00' },
    missedRun: 'skip',
    enabled: true,
    costCapUsd: 0.5,
    name: 'Report',
    path: 'Obi-I/Schedules/Report.md',
    message: 'Report on Sales.',
    ...over,
  }) as Schedule;

const snapshot = () => ({
  agents: [agent('ceo', 'CEO'), agent('coder', 'Coder')],
  groups,
  projects: [project()],
  schedules: [schedule()],
  skills,
});
const reply = (json: string) => '```agenthq-admin\n' + json + '\n```';

describe('Obi project actions: cards', () => {
  it('describes a new project with its teams, agents, skill and cost limit', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createProject","name":"Sales X","goal":"Sell more","teams":["Core team"],"agents":["CEO"],"skills":["sales-playbook"],"instructions":"Short."}]}',
      ),
      snapshot(),
    );
    expect(problems).toEqual([]);
    const [card] = proposals;
    expect(card!.title).toBe('Create project “Sales X”');
    expect(card!.fields).toContainEqual({ label: 'Teams', value: 'Core team' });
    expect(card!.fields).toContainEqual({ label: 'Agents', value: 'CEO' });
    expect(card!.fields).toContainEqual({
      label: 'Skills',
      value: 'sales-playbook',
    });
    expect(card!.fields).toContainEqual({ label: 'Cost limit', value: 'none' });
    expect(card!.texts[0]!.text).toBe('Short.');
  });

  it('shows a schedule as starting paused, with its cap and message', () => {
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createSchedule","name":"Weekly report","agent":"CEO","project":"Sales","message":"Report on Sales.","rule":{"kind":"weekly","day":1,"time":"09:00"},"costCapUsd":0.25}]}',
      ),
      snapshot(),
    );
    const card = proposals[0]!;
    expect(card.fields).toContainEqual({
      label: 'Starts',
      value: 'paused; you enable it after approving',
    });
    expect(card.fields).toContainEqual({
      label: 'Cost cap per run',
      value: '$0.25',
    });
    expect(card.fields).toContainEqual({
      label: 'Repeat',
      value: 'Every Monday at 09:00',
    });
  });

  it('shows enabled and the cap change before and after for an update', () => {
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSchedule","id":"Report","enabled":true,"costCapUsd":0.2}]}',
      ),
      { ...snapshot(), schedules: [schedule({ enabled: false })] },
    );
    expect(proposals[0]!.fields).toContainEqual({
      label: 'Enabled',
      value: 'no → yes',
    });
    expect(proposals[0]!.fields).toContainEqual({
      label: 'Cost cap per run',
      value: '$0.5 → $0.2',
    });
  });
});

describe('Obi project actions: cost limits and caps', () => {
  it('refuses to raise a project cost limit, and reports it', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateProject","id":"Sales","costLimitUsd":5}]}',
      ),
      snapshot(),
    );
    expect(proposals).toEqual([]);
    expect(problems[0]).toContain('Obi cannot raise a project cost limit');
  });

  it('refuses to remove a project cost limit', () => {
    const { problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateProject","id":"Sales","costLimitUsd":null}]}',
      ),
      snapshot(),
    );
    expect(problems[0]).toContain('Obi cannot remove a project cost limit');
  });

  it('allows lowering a project cost limit', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateProject","id":"Sales","costLimitUsd":0.5}]}',
      ),
      snapshot(),
    );
    expect(problems).toEqual([]);
    expect(proposals).toHaveLength(1);
  });

  it('refuses to raise or remove a schedule per-run cap, and allows lowering it', () => {
    const raise = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSchedule","id":"Report","costCapUsd":2}]}',
      ),
      snapshot(),
    );
    const remove = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSchedule","id":"Report","costCapUsd":null}]}',
      ),
      snapshot(),
    );
    const lower = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSchedule","id":"Report","costCapUsd":0.1}]}',
      ),
      snapshot(),
    );
    expect(raise.problems[0]).toContain(
      'Obi cannot raise a schedule per-run cap',
    );
    expect(remove.problems[0]).toContain(
      'Obi cannot remove a schedule per-run cap',
    );
    expect(lower.proposals).toHaveLength(1);
  });

  it('requires a cap on a schedule Obi creates', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createSchedule","name":"No cap","agent":"CEO","message":"Hi.","rule":{"kind":"daily","time":"09:00"}}]}',
      ),
      snapshot(),
    );
    expect(proposals).toEqual([]);
    expect(problems[0]).toContain('not valid');
  });

  it('re-checks the cost limit when the owner approves, against the data as it is then', async () => {
    const updateProject = vi.fn();
    const ops: ObiOps = {
      snapshot: () => ({
        ...snapshot(),
        projects: [project({ costLimitUsd: 0.5 })],
      }),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      createGroup: vi.fn(),
      renameGroup: vi.fn(),
      setManager: vi.fn(),
      projects: {
        createProject: vi.fn(),
        updateProject,
        createSchedule: vi.fn(),
        patchSchedule: vi.fn(),
      },
    };
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateProject","id":"Sales","costLimitUsd":0.8}]}',
      ),
      { ...snapshot(), projects: [project({ costLimitUsd: 1 })] },
    );
    // The proposal was allowed against a limit of 1; the limit is now 0.5, so raising it to 0.8 is refused.
    await expect(applyObiAction(proposals[0]!.action, ops)).rejects.toThrow(
      'Obi cannot raise a project cost limit',
    );
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe('Obi project actions: applying', () => {
  it('creates a schedule paused, even if the action asked for it enabled', async () => {
    const createSchedule = vi.fn(
      async () => 'Obi-I/Schedules/Weekly report.md',
    );
    const ops: ObiOps = {
      snapshot,
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      createGroup: vi.fn(),
      renameGroup: vi.fn(),
      setManager: vi.fn(),
      projects: {
        createProject: vi.fn(),
        updateProject: vi.fn(),
        createSchedule,
        patchSchedule: vi.fn(),
      },
    };
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createSchedule","name":"Weekly report","agent":"CEO","project":"Sales","message":"Report.","rule":{"kind":"daily","time":"09:00"},"costCapUsd":0.25}]}',
      ),
      snapshot(),
    );
    await applyObiAction(proposals[0]!.action, ops);
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'ceo',
        projectId: 'p1',
        enabled: false,
        costCapUsd: 0.25,
      }),
    );
  });

  it('creates a project through the same operation Setup uses, with the teams resolved to ids', async () => {
    const createProject = vi.fn(async () => {});
    const ops: ObiOps = {
      snapshot,
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      createGroup: vi.fn(),
      renameGroup: vi.fn(),
      setManager: vi.fn(),
      projects: {
        createProject,
        updateProject: vi.fn(),
        createSchedule: vi.fn(),
        patchSchedule: vi.fn(),
      },
    };
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createProject","name":"Sales X","teams":["Core team"],"skills":["sales-playbook"]}]}',
      ),
      snapshot(),
    );
    await applyObiAction(proposals[0]!.action, ops);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Sales X',
        teams: ['core'],
        skills: ['Obi-I/Skills/sales.md'],
        status: 'planned',
      }),
    );
  });

  it('has no delete action', () => {
    const { proposals, problems } = parseObiProposals(
      reply('{"actions":[{"type":"deleteProject","id":"Sales"}]}'),
      snapshot(),
    );
    expect(proposals).toEqual([]);
    expect(problems[0]).toContain('not valid');
  });
});

describe('Obi prompt: projects and schedules', () => {
  it('lists projects and schedules without any paths', () => {
    const prompt = obiPrompt(snapshot().agents, groups, {
      projects: [project()],
      schedules: [schedule()],
      skills,
    });
    expect(prompt).toContain('## Projects');
    expect(prompt).toContain(
      '- Sales (id p1): status active; teams Core team; agents none; cost limit $1',
    );
    expect(prompt).toContain('## Schedules');
    expect(prompt).toContain(
      '- Report: agent CEO; project Sales; Every day at 09:00; enabled; cost cap per run $0.5',
    );
    expect(prompt).not.toContain('Obi-I/Projects');
    expect(prompt).not.toContain('/private/work/tree');
  });
});
