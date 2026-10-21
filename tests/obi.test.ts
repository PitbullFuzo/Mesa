import { describe, expect, it, vi } from 'vitest';
import type { Agent, Group } from '../src/core/model';
import type { AgentSetupPatch } from '../src/core/setup';
import { MemoryStore } from '../src/core/memoryStore';
import {
  describeAction,
  OBI_GUIDE,
  OBI_ID,
  agentDisplayName,
  applyObiAction,
  ensureObi,
  obiPrompt,
  parseObiProposals,
  type ObiOps,
} from '../src/core/obi';

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id.toUpperCase(),
    role: 'Role',
    runtime: 'claude-code',
    permission: 'read-only',
    vaultAccess: 'read',
    webAccess: false,
    group: null,
    reportsTo: null,
    model: '',
    workdir: '/private/work/tree',
    ...extra,
  } as Agent;
}

const ceo = agent('ceo');
const groups: Group[] = [{ id: 'core', name: 'Core team', color: '#7c3aed' }];

function reply(json: string): string {
  return `Here is my proposal.\n\n\`\`\`agenthq-admin\n${json}\n\`\`\``;
}

describe('Obi proposals', () => {
  it('turns each action in a valid block into one proposal', () => {
    const { proposals, problems } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createGroup","name":"Research","color":"#2563eb"},{"type":"createAgent","name":"Researcher","group":"Research","reportsTo":"CEO"}]}',
      ),
      { agents: [ceo], groups },
    );
    expect(problems).toEqual([]);
    expect(proposals.map((entry) => entry.action.type)).toEqual([
      'createGroup',
      'createAgent',
    ]);
    expect(proposals[1]!.title).toContain('Researcher');
  });

  it('reports invalid JSON and proposes nothing', () => {
    const result = parseObiProposals(reply('{"actions":['), {
      agents: [ceo],
      groups,
    });
    expect(result.proposals).toEqual([]);
    expect(result.problems[0]).toContain('not valid JSON');
  });

  it('refuses each forbidden field with a reason and keeps the valid actions', () => {
    const cases = [
      '{"type":"updateAgent","id":"ceo","permission":"full"}',
      '{"type":"updateAgent","id":"ceo","vaultAccess":"write"}',
      '{"type":"updateAgent","id":"ceo","webAccess":true}',
      '{"type":"updateAgent","id":"ceo","wholeComputerReadConfirmed":true}',
      '{"type":"updateAgent","id":"ceo","canUseBrowser":true}',
    ];
    for (const action of cases) {
      const { proposals, problems } = parseObiProposals(
        reply(
          `{"actions":[${action},{"type":"createGroup","name":"Ok","color":"#000000"}]}`,
        ),
        { agents: [ceo], groups },
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('Action 1 refused');
      expect(proposals.map((entry) => entry.action.type)).toEqual([
        'createGroup',
      ]);
    }
  });

  it('does not offer deleting agents or groups', () => {
    const { proposals, problems } = parseObiProposals(
      reply('{"actions":[{"type":"deleteAgent","id":"ceo"}]}'),
      { agents: [ceo], groups },
    );
    expect(proposals).toEqual([]);
    expect(problems[0]).toContain('not valid');
  });
});

describe('applying an approved Obi action', () => {
  function fakeOps(agents: Agent[], groupList: Group[]) {
    const state = { agents: [...agents], groups: [...groupList] };
    const calls: string[] = [];
    const ops: ObiOps = {
      snapshot: () => state,
      createAgent: vi.fn(async (name: string) => {
        calls.push(`createAgent ${name}`);
        state.agents.push(agent(name.toLowerCase()));
        return name.toLowerCase();
      }),
      updateAgent: vi.fn(async (id: string, patch: AgentSetupPatch) => {
        calls.push(`updateAgent ${id} ${JSON.stringify(patch)}`);
      }),
      createGroup: vi.fn(async (name: string, color: string) => {
        const id = `group-${name.toLowerCase()}`;
        calls.push(`createGroup ${name}`);
        state.groups.push({ id, name, color });
        return id;
      }),
      renameGroup: vi.fn(async () => {}),
      setManager: vi.fn(async (id: string, managerId: string | null) => {
        calls.push(`setManager ${id} ${managerId}`);
      }),
    };
    return { ops, calls };
  }

  it('creates a group, then an agent in it reporting to the CEO, through the same functions', async () => {
    const { proposals } = parseObiProposals(
      reply(
        '{"actions":[{"type":"createGroup","name":"Research","color":"#2563eb"},{"type":"createAgent","name":"Researcher","group":"Research","reportsTo":"CEO","instructions":"Short."}]}',
      ),
      { agents: [ceo], groups },
    );
    const { ops, calls } = fakeOps([ceo], groups);
    for (const proposal of proposals)
      await applyObiAction(proposal.action, ops);
    expect(calls).toEqual([
      'createGroup Research',
      'createAgent Researcher',
      `updateAgent researcher ${JSON.stringify({ instructions: 'Short.', group: 'group-research' })}`,
      'setManager researcher ceo',
    ]);
  });

  it('resolves an existing group and an unknown one is reported', async () => {
    const { ops, calls } = fakeOps([ceo], groups);
    await expect(
      applyObiAction({ type: 'updateAgent', id: 'ceo', group: 'Nowhere' }, ops),
    ).rejects.toThrow('No group called “Nowhere”.');
    await applyObiAction(
      { type: 'updateAgent', id: 'ceo', group: 'core' },
      ops,
    );
    expect(calls).toContain(
      `updateAgent ceo ${JSON.stringify({ group: 'core' })}`,
    );
  });
});

describe('Obi prompt and note', () => {
  it('includes a correct team snapshot and no workdir paths', () => {
    const prompt = obiPrompt(
      [
        ceo,
        agent('coder', { reportsTo: 'ceo', group: 'core', runtime: 'codex' }),
      ],
      groups,
    );
    expect(prompt).toContain('## Team snapshot');
    expect(prompt).toContain('CEO (id ceo)');
    expect(prompt).toContain('reports to CEO');
    expect(prompt).toContain('group Core team');
    expect(prompt).toContain('runtime codex');
    expect(prompt).toContain('## Groups');
    expect(prompt).not.toContain('/private/work/tree');
  });

  it('is labelled Obi in panels while its note stays Obi', () => {
    expect(agentDisplayName(agent(OBI_ID, { name: 'Obi' }))).toBe('Obi');
    expect(agentDisplayName(agent('ceo'))).toBe('CEO');
  });

  it('creates Obi and its guide once, and never overwrites them', async () => {
    const store = new MemoryStore();
    expect(await ensureObi(store, store.root)).toBe(true);
    const { agents } = await store.loadAgents();
    const obi = agents.find((entry) => entry.id === OBI_ID)!;
    expect(obi.permission).toBe('read-only');
    expect(obi.vaultAccess).toBe('read');
    expect(obi.webAccess).toBe(false);
    expect(obi.runtime).toBe('claude-code');
    expect(await store.exists(`${store.root}/Skills/Mesa guide.md`)).toBe(true);

    const creates = vi.spyOn(store, 'createNote');
    expect(await ensureObi(store, store.root)).toBe(false);
    expect(creates).not.toHaveBeenCalled();
  });
});

describe('approval card content', () => {
  const snapshot = {
    agents: [
      ceo,
      agent('coder', {
        reportsTo: 'ceo',
        skills: ['[[old-skill]]'],
        instructions: 'Old line one.\nOld line two.',
        role: 'Engineer',
      }),
    ],
    groups,
  };
  const field = (
    card: { fields: { label: string; value: string }[] },
    label: string,
  ) => card.fields.find((entry) => entry.label === label)?.value;

  it('shows every field a new agent will get, with the full instructions', () => {
    const card = describeAction(
      {
        type: 'createAgent',
        name: 'Researcher',
        role: 'Analyst',
        group: 'core',
        reportsTo: 'CEO',
        runtime: 'codex',
        model: 'gpt-x',
        permission: 'edit',
        vaultAccess: 'off',
        instructions: 'Read <b>notes</b> carefully.\n- Cite sources.',
      },
      snapshot,
    );
    expect(card.title).toBe('Create agent “Researcher”');
    expect(field(card, 'Name')).toBe('Researcher');
    expect(field(card, 'Role')).toBe('Analyst');
    expect(field(card, 'Group')).toBe('Core team');
    expect(field(card, 'Manager')).toBe('CEO');
    expect(field(card, 'Runtime')).toBe('codex');
    expect(field(card, 'Model')).toBe('gpt-x');
    expect(field(card, 'Permission')).toBe('edit');
    expect(field(card, 'Vault access')).toBe('off');
    expect(field(card, 'Web access')).toBe('off');
    expect(card.texts[0]!.text).toBe(
      'Read <b>notes</b> carefully.\n- Cite sources.',
    );
    expect(card.texts[0]!.open).toBe(true);
  });

  it('shows old and new instructions in full, with long new text collapsed', () => {
    const long = Array.from(
      { length: 20 },
      (_, index) => `Step ${index + 1}`,
    ).join('\n');
    const card = describeAction(
      { type: 'updateAgent', id: 'coder', instructions: long },
      snapshot,
    );
    expect(card.texts).toEqual([
      { label: 'Instructions (new)', text: long, open: false },
      {
        label: 'Instructions (current)',
        text: 'Old line one.\nOld line two.',
        open: false,
      },
    ]);
  });

  it('shows before and after for changed fields and names of skills added and removed', () => {
    const card = describeAction(
      {
        type: 'updateAgent',
        id: 'Coder',
        role: 'Senior engineer',
        skills: ['[[new-skill]]'],
        reportsTo: null,
      },
      snapshot,
    );
    expect(card.title).toBe('Update CODER');
    expect(field(card, 'Role')).toBe('Engineer → Senior engineer');
    expect(field(card, 'Manager')).toBe('CEO → none');
    expect(field(card, 'Skills added')).toBe('[[new-skill]]');
    expect(field(card, 'Skills removed')).toBe('[[old-skill]]');
  });

  it('describes groups and managers with their names', () => {
    expect(
      describeAction(
        { type: 'createGroup', name: 'Research', color: '#2563eb' },
        snapshot,
      ).fields,
    ).toEqual([
      { label: 'Name', value: 'Research' },
      { label: 'Colour', value: '#2563eb' },
    ]);
    expect(
      describeAction(
        { type: 'renameGroup', id: 'core', name: 'Leads' },
        snapshot,
      ).fields[0]!.value,
    ).toBe('Core team → Leads');
    expect(
      describeAction(
        { type: 'setManager', id: 'coder', managerId: null },
        snapshot,
      ).fields[0]!.value,
    ).toBe('CEO → none');
  });
});

describe('Obi guide', () => {
  it('does not mention the removed Dots view', () => {
    expect(OBI_GUIDE).not.toMatch(/Dots/);
    expect(OBI_GUIDE).toContain('AI Graph');
  });
});
