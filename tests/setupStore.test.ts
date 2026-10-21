import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import { DEFAULT_RUNTIME_ID } from '../src/core/runtimes/ids';

const raw = {
  agenthq: 'agent',
  id: 'coder',
  role: 'Coder',
  runtime: DEFAULT_RUNTIME_ID,
  permission: 'read-only',
  skills: [],
};

describe('field-only agent persistence', () => {
  it('rejects link delimiters on create and rename without breaking existing connections', async () => {
    const store = new MemoryStore();
    const lead = await store.createAgent('Lead');
    const child = await store.createAgent('Child');
    await store.setManager(child, lead);
    for (const name of [
      'Team #1',
      'Lead^block',
      'Lead[one',
      'Lead]one',
      'Lead|alias',
    ]) {
      await expect(store.createAgent(name)).rejects.toThrow(/wikilink/i);
      await expect(store.patchAgent(lead, { name })).rejects.toThrow(
        /wikilink/i,
      );
      expect(
        (await store.loadAgents()).agents.find((agent) => agent.id === child)
          ?.reportsTo,
      ).toBe(lead);
    }
    await store.patchAgent(lead, { name: 'Safe lead' });
    await store.setManager(child, lead);
    expect(
      (await store.loadAgents()).agents.find((agent) => agent.id === child)
        ?.reportsTo,
    ).toBe(lead);
    expect(store.notes.get('Mesa/Agents/Child.md')?.frontmatter).toMatchObject({
      reportsTo: '[[Safe lead]]',
    });
  });
  it('creates unique safe names and stable slugs without overwriting invalid notes', async () => {
    const store = new MemoryStore('Team');
    await store.createNote(
      'Team/Agents/New agent.md',
      { id: 'new-agent', broken: true },
      'keep',
    );
    const first = await store.createAgent('New agent');
    const second = await store.createAgent('New agent');
    expect(first).toBe('new-agent-2');
    expect(second).toBe('new-agent-3');
    expect((await store.loadAgents()).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first,
          name: 'New agent 2',
          role: '',
          runtime: DEFAULT_RUNTIME_ID,
          permission: 'read-only',
          group: null,
          model: '',
          workdir: '',
          verifier: null,
          skills: [],
          instructions: '',
        }),
        expect.objectContaining({ id: second, name: 'New agent 3' }),
      ]),
    );
    expect(store.notes.get('Team/Agents/New agent.md')?.body).toBe('keep');
    await expect(store.createAgent('../escape')).rejects.toThrow();
    const unicodeId = await store.createAgent('工程師');
    expect(unicodeId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
  it('connects and disconnects only manager fields and rejects direct runtime cycles', async () => {
    const store = new MemoryStore();
    await store.createNote(
      'Mesa/Agents/Coder.md',
      { ...raw, verifier: '[[Missing]]' },
      'Coder',
    );
    await store.createNote(
      'Mesa/Agents/Lead.md',
      { ...raw, id: 'lead' },
      'Lead',
    );
    await store.setManager('coder', 'lead');
    expect(store.notes.get('Mesa/Agents/Coder.md')).toMatchObject({
      frontmatter: { reportsTo: '[[Lead]]', verifier: '[[Missing]]' },
      body: 'Coder',
    });
    await expect(store.setManager('lead', 'coder')).rejects.toThrow(/loop/i);
    await expect(store.setManager('lead', 'lead')).rejects.toThrow(/loop/i);
    await expect(store.setManager('coder', 'missing')).rejects.toThrow(
      /unknown/i,
    );
    await store.setManager('coder', null);
    expect(store.notes.get('Mesa/Agents/Coder.md')?.frontmatter).toMatchObject({
      reportsTo: null,
    });
  });
  it('deletes a manager, reparents direct reports, leaves verifier links and raw broken lineage intact', async () => {
    const store = new MemoryStore();
    await store.createNote(
      'Mesa/Agents/CEO.md',
      { ...raw, id: 'ceo', permission: 'broken' },
      'Broken CEO',
    );
    await store.createNote(
      'Mesa/Agents/Lead.md',
      { ...raw, id: 'lead', reportsTo: '[[CEO]]' },
      'Lead',
    );
    await store.createNote(
      'Mesa/Agents/Coder.md',
      { ...raw, reportsTo: '[[Lead]]', verifier: '[[Lead]]', custom: 'keep' },
      'Coder',
    );
    await store.createNote(
      'Mesa/Agents/Intern.md',
      { ...raw, id: 'intern', reportsTo: '[[Coder]]' },
      'Intern',
    );
    await store.deleteAgent('lead');
    expect(store.notes.has('Mesa/Agents/Lead.md')).toBe(false);
    expect(store.notes.get('Mesa/Agents/Coder.md')).toMatchObject({
      frontmatter: {
        reportsTo: '[[CEO]]',
        verifier: '[[Lead]]',
        custom: 'keep',
      },
      body: 'Coder',
    });
    expect(store.notes.get('Mesa/Agents/Intern.md')?.frontmatter).toMatchObject(
      { reportsTo: '[[Coder]]' },
    );
    expect(
      (await store.loadAgents()).agents.find((a) => a.id === 'coder')?.warnings,
    ).toHaveLength(2);
    await store.deleteAgent('coder');
    expect(store.notes.get('Mesa/Agents/Intern.md')?.frontmatter).toMatchObject(
      { reportsTo: '[[CEO]]' },
    );
    await expect(store.deleteAgent('missing')).rejects.toThrow(/unknown/i);
  });
  it('reparents reports to a valid grandparent or null when deleting a top-level manager', async () => {
    const store = new MemoryStore();
    for (const [id, name, reportsTo] of [
      ['ceo', 'CEO', null],
      ['lead', 'Lead', '[[CEO]]'],
      ['coder', 'Coder', '[[Lead]]'],
    ] as const)
      await store.createNote(
        `Mesa/Agents/${name}.md`,
        { ...raw, id, reportsTo },
        name,
      );
    await store.deleteAgent('lead');
    expect(
      (await store.loadAgents()).agents.find((a) => a.id === 'coder')
        ?.reportsTo,
    ).toBe('ceo');
    await store.deleteAgent('ceo');
    expect(store.notes.get('Mesa/Agents/Coder.md')?.frontmatter).toMatchObject({
      reportsTo: null,
    });
  });
  it('broken CEO -> change Coder role -> raw reportsTo [[CEO]] remains intact', async () => {
    const store = new MemoryStore();
    await store.createNote(
      'Mesa/Agents/CEO.md',
      { ...raw, id: 'ceo', permission: 'broken' },
      'CEO',
    );
    const path = 'Mesa/Agents/Coder.md';
    const fm = {
      ...raw,
      reportsTo: '[[CEO]]',
      verifier: '[[Missing verifier]]',
      skills: ['[[Missing skill]]'],
      custom: { keep: true },
    };
    await store.createNote(path, fm, 'Instructions');
    expect((await store.loadAgents()).agents[0]?.reportsTo).toBeNull();
    await store.patchAgent('coder', { role: 'Engineer' });
    expect(store.notes.get(path)).toMatchObject({
      frontmatter: { ...fm, role: 'Engineer' },
      body: 'Instructions',
    });
  });
  it('patches each Setup field, renames wikilinks, and preserves stable ids/layout', async () => {
    const store = new MemoryStore();
    await store.createNote(
      'Mesa/Agents/Coder.md',
      { ...raw, custom: 'keep' },
      'Old',
    );
    await store.createNote(
      'Mesa/Agents/Reviewer.md',
      { ...raw, id: 'reviewer', reportsTo: '[[Coder]]', verifier: '[[Coder]]' },
      'Review [[Coder]]',
    );
    await store.createNote('Mesa/Skills/rules.md', {}, 'Rules');
    await store.createNote(
      'Mesa/Chats/Chat.md',
      { agent: '[[Mesa/Agents/Coder|Worker]]' },
      'See [[Coder#Heading|worker]]',
    );
    await store.saveLayout({ coder: { x: 10, y: 20 } });
    await store.patchAgent('coder', {
      name: 'Engineer',
      role: '',
      runtime: 'other',
      model: 'model',
      permission: 'edit',
      workdir: 'Projects',
      verifier: 'reviewer',
      group: 'team',
      skills: ['Mesa/Skills/rules.md'],
      instructions: 'New',
    });
    expect(store.notes.has('Mesa/Agents/Coder.md')).toBe(false);
    expect(
      (await store.loadAgents()).agents.find((a) => a.id === 'coder'),
    ).toMatchObject({
      name: 'Engineer',
      role: '',
      runtime: 'other',
      model: 'model',
      permission: 'edit',
      workdir: 'Projects',
      verifier: 'reviewer',
      group: 'team',
      skills: ['Mesa/Skills/rules.md'],
      instructions: 'New',
    });
    expect(
      store.notes.get('Mesa/Agents/Engineer.md')?.frontmatter,
    ).toMatchObject({ id: 'coder', custom: 'keep' });
    expect(store.notes.get('Mesa/Agents/Reviewer.md')).toMatchObject({
      frontmatter: { reportsTo: '[[Engineer]]', verifier: '[[Engineer]]' },
      body: 'Review [[Engineer]]',
    });
    expect(store.notes.get('Mesa/Chats/Chat.md')).toMatchObject({
      frontmatter: { agent: '[[Mesa/Agents/Engineer|Worker]]' },
      body: 'See [[Engineer#Heading|worker]]',
    });
    expect(await store.loadLayout()).toEqual({ coder: { x: 10, y: 20 } });
    await store.patchAgent('coder', {
      model: '',
      workdir: '',
      verifier: null,
      group: null,
      skills: [],
      instructions: '',
    });
    expect(store.notes.get('Mesa/Agents/Engineer.md')).toMatchObject({
      frontmatter: {
        model: '',
        workdir: '',
        verifier: null,
        group: null,
        skills: [],
      },
      body: '',
    });
    await expect(
      store.patchAgent('coder', { name: 'Reviewer' }),
    ).rejects.toThrow(/exist/i);
    await expect(
      store.patchAgent('coder', { name: '../escape' }),
    ).rejects.toThrow();
    await expect(store.patchAgent('missing', { role: 'x' })).rejects.toThrow(
      /unknown/i,
    );
  });
});
