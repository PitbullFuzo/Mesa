import { describe, expect, it, vi } from 'vitest';
import type { Agent, Skill } from '../src/core/model';
import type { Project } from '../src/core/projects';
import {
  applyObiAction,
  parseObiProposals,
  type ObiOps,
} from '../src/core/obi';
import { skillActionSchema, type SkillOps } from '../src/core/obiSkills';

function agent(id: string, name: string): Agent {
  return {
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
    workdir: '/private/work/tree',
    skills: [],
  } as unknown as Agent;
}
const longInstructions = Array.from(
  { length: 20 },
  (_, line) => `Step ${line + 1}: do the thing.`,
).join('\n');
const skills: Skill[] = [
  {
    path: 'Obi-I/Skills/sales-follow-up.md',
    name: 'sales-follow-up',
    body: 'Send the recap.',
    description: 'Follow up leads.',
  },
];
const snapshot = () => ({
  agents: [agent('ceo', 'CEO'), agent('coder', 'Coder')],
  groups: [],
  projects: [] as Project[],
  skills,
});
const reply = (json: string) => '```agenthq-admin\n' + json + '\n```';

describe('Obi skill actions: schema', () => {
  it('has no delete action, and rejects a skill action with extra fields', () => {
    expect(
      skillActionSchema.safeParse({ type: 'deleteSkill', id: 'x' }).success,
    ).toBe(false);
    expect(
      skillActionSchema.safeParse({
        type: 'createSkill',
        name: 'A',
        description: '',
        instructions: 'Do it.',
        path: 'Obi-I/Skills/A.md',
      }).success,
    ).toBe(false);
  });

  it('needs something to change in an update, and someone to assign to', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSkill","id":"sales-follow-up"},{"type":"assignSkill","skill":"sales-follow-up"}]}',
      ),
      snapshot(),
    );
    expect(proposals).toEqual([]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Say what to change');
    expect(problems[1]).toContain('Name at least one agent or project');
  });
});

describe('Obi skill actions: cards', () => {
  it('shows a new skill with its full instructions, even when long', () => {
    const { proposals } = parseObiProposals(
      reply(
        JSON.stringify({
          actions: [
            {
              type: 'createSkill',
              name: 'Quote follow-up',
              description: 'Chase quotes.',
              instructions: longInstructions,
            },
          ],
        }),
      ),
      snapshot(),
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title).toBe('Create skill “Quote follow-up”');
    expect(proposals[0]!.fields).toContainEqual({
      label: 'Description',
      value: 'Chase quotes.',
    });
    expect(proposals[0]!.texts[0]!.text).toBe(longInstructions);
    expect(proposals[0]!.texts[0]!.open).toBe(false);
  });

  it('shows the current and the new instructions in full for an update', () => {
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"updateSkill","id":"sales-follow-up","description":"Chase quotes.","instructions":"Only this now."}]}',
      ),
      snapshot(),
    );
    const card = proposals[0]!;
    expect(card.title).toBe('Update skill “sales-follow-up”');
    expect(card.fields).toContainEqual({
      label: 'Description',
      value: 'Follow up leads. → Chase quotes.',
    });
    expect(card.texts).toEqual([
      { label: 'Instructions (now)', text: 'Send the recap.', open: true },
      { label: 'Instructions (new)', text: 'Only this now.', open: true },
    ]);
  });

  it('shows who gets the skill, before and after', () => {
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"assignSkill","skill":"sales-follow-up","agents":["Coder"]}]}',
      ),
      snapshot(),
    );
    expect(proposals[0]!.fields).toContainEqual({
      label: 'Agents',
      value: 'none → Coder',
    });
  });
});

describe('Obi skill actions: references', () => {
  it('refuses an unknown skill, agent or project name', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"assignSkill","skill":"nope","agents":["Coder"]},{"type":"assignSkill","skill":"sales-follow-up","agents":["Ghost"]},{"type":"assignSkill","skill":"sales-follow-up","projects":["Ghost"]}]}',
      ),
      snapshot(),
    );
    expect(proposals).toEqual([]);
    expect(problems).toEqual([
      'Action 1 was not valid: No skill called “nope”.',
      'Action 2 was not valid: No agent called “Ghost”.',
      'Action 3 was not valid: No project called “Ghost”.',
    ]);
  });

  it('accepts assigning a skill that this same reply creates', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createSkill","name":"Quote follow-up","description":"","instructions":"Chase."},{"type":"assignSkill","skill":"Quote follow-up","agents":["Coder"]}]}',
      ),
      snapshot(),
    );
    expect(problems).toEqual([]);
    expect(proposals.map((proposal) => proposal.action.type)).toEqual([
      'createSkill',
      'assignSkill',
    ]);
  });
});

describe('Obi skill actions: applying', () => {
  function ops() {
    const skillCalls: Record<string, unknown[]> = {};
    const record = (name: string, value: unknown) => {
      (skillCalls[name] ??= []).push(value);
    };
    const skills: SkillOps = {
      createSkill: async (input) => {
        record('createSkill', input);
        return 'Obi-I/Skills/quote-follow-up.md';
      },
      updateSkill: async (path, patch) => {
        record('updateSkill', { path, patch });
      },
      assignSkill: async (path, change) => {
        record('assignSkill', { path, change });
      },
    };
    return {
      skillCalls,
      snapshot: () => snapshot(),
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
      createGroup: vi.fn(),
      renameGroup: vi.fn(),
      setManager: vi.fn(),
      skills,
    };
  }

  it('creates, updates and assigns through the skill operations, resolving names', async () => {
    const o = ops();
    await applyObiAction(
      {
        type: 'createSkill',
        name: 'Quote follow-up',
        description: 'Chase quotes.',
        instructions: 'Chase.',
      },
      o,
    );
    await applyObiAction(
      {
        type: 'updateSkill',
        id: 'sales-follow-up',
        instructions: 'Only this now.',
      },
      o,
    );
    await applyObiAction(
      {
        type: 'assignSkill',
        skill: 'sales-follow-up',
        agents: ['Coder'],
      },
      o,
    );
    expect(o.skillCalls.createSkill).toEqual([
      {
        name: 'Quote follow-up',
        description: 'Chase quotes.',
        instructions: 'Chase.',
      },
    ]);
    expect(o.skillCalls.updateSkill).toEqual([
      {
        path: 'Obi-I/Skills/sales-follow-up.md',
        patch: { instructions: 'Only this now.' },
      },
    ]);
    expect(o.skillCalls.assignSkill).toEqual([
      {
        path: 'Obi-I/Skills/sales-follow-up.md',
        change: { agentIds: ['coder'], projectIds: [], add: true },
      },
    ]);
  });

  it('refuses to apply when the skill operations are not available', async () => {
    const plain = { ...ops(), skills: undefined } as unknown as ObiOps;
    await expect(
      applyObiAction(
        {
          type: 'updateSkill',
          id: 'sales-follow-up',
          description: 'x',
        },
        plain,
      ),
    ).rejects.toThrow('Skills cannot be changed here');
  });
});
