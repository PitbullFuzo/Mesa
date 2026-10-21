import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import type { Store } from '../src/core/store';

const raw = {
  agenthq: 'agent',
  id: 'lead',
  role: 'Lead',
  runtime: 'test',
  permission: 'read-only',
  skills: [],
};

describe('MemoryStore', () => {
  it('keeps reference fallbacks snapshot-only and never persists warnings', async () => {
    const store = new MemoryStore('Team');
    const path = 'Team/Agents/Lead.md';
    await store.createNote(
      path,
      {
        ...raw,
        reportsTo: '[[Missing manager]]',
        verifier: '[[Missing verifier]]',
        skills: ['[[Deleted skill]]'],
      },
      'Instructions',
    );
    const before = structuredClone([...store.notes.entries()]);
    const result = await store.loadAgents();
    expect(result.invalidAgents).toEqual([]);
    const agent = result.agents[0]!;
    expect(agent).toMatchObject({
      reportsTo: null,
      verifier: null,
      skills: [],
    });
    expect(agent.warnings).toHaveLength(3);
    expect([...store.notes.entries()]).toEqual(before);
    await store.saveAgent(agent);
    expect(store.notes.get(path)?.frontmatter).toMatchObject({
      reportsTo: null,
      verifier: null,
      skills: [],
    });
    expect(store.notes.get(path)?.frontmatter).not.toHaveProperty('warnings');
    expect((await store.loadAgents()).agents[0]?.warnings).toEqual([]);
  });
  it('saves agent references as wiki links and round trips stable ids', async () => {
    const store = new MemoryStore('Team');
    await store.createNote('Team/Agents/Director.md', raw, 'Lead');
    await store.createNote(
      'Team/Agents/Reviewer.md',
      { ...raw, id: 'reviewer' },
      'Review',
    );
    await store.createNote('Team/Skills/rules.md', {}, 'Rules');
    const lead = (await store.loadAgents()).agents[0]!;
    await store.saveAgent({
      ...lead,
      id: 'coder',
      name: 'Coder',
      path: 'Team/Agents/Coder.md',
      reportsTo: 'lead',
      verifier: 'reviewer',
      skills: ['Team/Skills/rules.md'],
    });
    expect(store.notes.get('Team/Agents/Coder.md')?.frontmatter).toMatchObject({
      reportsTo: '[[Director]]',
      verifier: '[[Reviewer]]',
      skills: ['[[Team/Skills/rules]]'],
    });
    expect(
      (await store.loadAgents()).agents.find((a) => a.id === 'coder'),
    ).toMatchObject({
      reportsTo: 'lead',
      verifier: 'reviewer',
      skills: ['Team/Skills/rules.md'],
    });
    await expect(
      store.saveAgent({ ...lead, reportsTo: 'unknown' }),
    ).rejects.toThrow(/unknown|missing/i);
  });
  it('persists groups, skills, layout and record slots with isolated clones', async () => {
    const store = new MemoryStore('Team');
    expect(await store.loadGroups()).toEqual([]);
    expect(await store.loadLayout()).toEqual({});
    const groups = [{ id: 'core', name: 'Core team', color: '#123456' }];
    await store.saveGroups(groups);
    groups[0]!.name = 'Changed';
    const loaded = await store.loadGroups();
    expect(loaded[0]?.name).toBe('Core team');
    loaded[0]!.name = 'Mutated';
    expect((await store.loadGroups())[0]?.name).toBe('Core team');
    const layout = { lead: { x: 1, y: 2 } };
    await store.saveLayout(layout);
    layout.lead.x = 10;
    const read = await store.loadLayout();
    expect(read.lead?.x).toBe(1);
    read.lead!.x = 20;
    expect((await store.loadLayout()).lead?.x).toBe(1);
    await store.saveNote('Team/Skills/rules.md', {}, 'Rules');
    expect(await store.loadSkills()).toEqual([
      { path: 'Team/Skills/rules.md', name: 'rules', body: 'Rules' },
    ]);
    for (const [folder, kind] of [
      ['Chats', 'chat'],
      ['Tasks', 'task'],
      ['Activity', 'activity'],
    ]) {
      await store.saveNote(
        `Team/${folder}/Example.md`,
        { agenthq: kind },
        'Body',
      );
    }
    expect(await store.loadChats()).toHaveLength(1);
    expect(await store.loadTasks()).toHaveLength(1);
    expect(await store.loadActivity()).toHaveLength(1);
    const chats = await store.loadChats();
    chats[0]!.body = 'Mutation';
    expect((await store.loadChats())[0]?.body).toBe('Body');
  });
  it('creates notes and folders without overwriting existing content and clones inputs and reads', async () => {
    const store: Store = new MemoryStore('Team');
    expect(await store.exists('Team')).toBe(false);
    await store.createFolder('Team');
    await store.createFolder('Team/Agents');
    expect(await store.exists('Team')).toBe(true);
    const fm = { ...raw, skills: [] as string[] };
    await store.createNote('Team/Agents/Lead.md', fm, 'Lead instructions');
    fm.skills.push('changed');
    await expect(
      store.createNote('Team/Agents/Lead.md', raw, 'Overwrite'),
    ).rejects.toThrow();
    const result = await store.loadAgents();
    expect(result.agents[0]).toMatchObject({
      id: 'lead',
      name: 'Lead',
      reportsTo: null,
      instructions: 'Lead instructions',
      skills: [],
    });
    result.agents[0]?.skills.push('mutated');
    expect((await store.loadAgents()).agents[0]?.skills).toEqual([]);
    expect((store as MemoryStore).folders.has('Team/Agents')).toBe(true);
  });
});
