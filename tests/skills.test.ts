import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import { createProjectNote, loadValidProjects } from '../src/core/projects';
import {
  assignSkill,
  createSkillNote,
  deleteSkill,
  linkTargetName,
  skillDescription,
  skillSize,
  skillUsers,
  updateSkillNote,
} from '../src/core/skills';

/**
 * Links the agent to a note that exists but is not a skill. The store drops links that resolve to nothing, so
 * this is the case that reaches the "does not resolve to a skill" check.
 */
async function brokenLink(
  store: MemoryStore,
  agentId: string,
): Promise<string> {
  const path = 'Mesa/Notes/Plain.md';
  await store.createNote(path, {}, 'Not a skill.');
  await store.patchAgent(agentId, { skills: [path] });
  return path;
}

async function setup() {
  const store = new MemoryStore('Mesa');
  const coder = await store.createAgent('Coder');
  const projectPath = await createProjectNote(store, 'Mesa', {
    name: 'Sales',
  });
  const projectId = loadValidProjects(await store.loadProjects()).find(
    (project) => project.path === projectPath,
  )!.id;
  const skillPath = await createSkillNote(store, 'Mesa', {
    name: 'Sales follow-up',
    description: 'Follow up leads after a call.',
    instructions: '## Steps\n1. Send the recap.',
  });
  const skill = (await store.loadSkills()).find(
    (entry) => entry.path === skillPath,
  )!;
  const agentNow = async () =>
    (await store.loadAgents()).agents.find((agent) => agent.id === coder)!;
  const projectNow = async () =>
    loadValidProjects(await store.loadProjects()).find(
      (project) => project.id === projectId,
    )!;
  return { store, coder, projectId, skill, agentNow, projectNow };
}

describe('skill links and sizes', () => {
  it('takes the file name from a wikilink, without alias, heading or folder', () => {
    expect(linkTargetName('[[Folder/karpathy-guidelines.md|Alias]]')).toBe(
      'karpathy-guidelines',
    );
    expect(linkTargetName('[[Sales follow-up#Steps]]')).toBe('Sales follow-up');
  });

  it('estimates the words and tokens a skill adds to a prompt', () => {
    const skill = { path: 'x', name: 'x', body: 'one two  three' };
    expect(skillSize(skill)).toEqual({ words: 3, tokens: 4 });
    expect(skillDescription({ ...skill, description: ' Sell well. ' })).toBe(
      'Sell well.',
    );
    expect(skillDescription({ ...skill, body: '# Title\n\nFirst line.' })).toBe(
      'First line.',
    );
  });
});

describe('skill notes', () => {
  it('never overwrites an existing skill: a second one with the same name gets a suffix', async () => {
    const { store } = await setup();
    const again = await createSkillNote(store, 'Mesa', {
      name: 'Sales follow-up',
      description: '',
      instructions: 'Other text.',
    });
    expect(again).toMatch(/ \(2\)\.md$/);
    expect((await store.loadSkills()).map((skill) => skill.body)).toEqual(
      expect.arrayContaining(['## Steps\n1. Send the recap.', 'Other text.']),
    );
  });

  it('edits the description and instructions but keeps the name', async () => {
    const { store, skill } = await setup();
    await updateSkillNote(store, skill, {
      description: 'New words.',
      instructions: 'Only this now.',
    });
    const [after] = (await store.loadSkills()).filter(
      (entry) => entry.path === skill.path,
    );
    expect(after).toMatchObject({
      name: 'Sales follow-up',
      description: 'New words.',
      body: 'Only this now.',
    });
  });
});

describe('assigning and removing a skill', () => {
  it('adds the skill to an agent and a project, and removes it again', async () => {
    const { store, coder, projectId, skill, agentNow, projectNow } =
      await setup();
    await assignSkill(store, skill, {
      agentIds: [coder],
      projectIds: [projectId],
      add: true,
    });
    expect((await agentNow()).skills).toEqual([skill.path]);
    expect((await projectNow()).skills).toEqual([skill.path]);
    const users = skillUsers(
      skill,
      (await store.loadAgents()).agents,
      loadValidProjects(await store.loadProjects()),
    );
    expect(users.agents.map((agent) => agent.id)).toEqual([coder]);
    expect(users.projects.map((project) => project.id)).toEqual([projectId]);

    await assignSkill(store, skill, {
      agentIds: [coder],
      projectIds: [projectId],
      add: false,
    });
    expect((await agentNow()).skills).toEqual([]);
    expect((await projectNow()).skills).toEqual([]);
  });

  it('refuses to assign while an agent has a skill link that does not resolve, and changes nothing', async () => {
    const { store, coder, skill, agentNow } = await setup();
    const plain = await brokenLink(store, coder);
    await expect(
      assignSkill(store, skill, {
        agentIds: [coder],
        projectIds: [],
        add: true,
      }),
    ).rejects.toThrow('does not resolve');
    expect((await agentNow()).skills).toEqual([plain]);
  });
});

describe('deleting a skill', () => {
  it('takes the skill off every agent and project, then moves the note to the trash', async () => {
    const { store, coder, projectId, skill, agentNow, projectNow } =
      await setup();
    await assignSkill(store, skill, {
      agentIds: [coder],
      projectIds: [projectId],
      add: true,
    });
    await deleteSkill(store, skill);
    expect((await agentNow()).skills).toEqual([]);
    expect((await projectNow()).skills).toEqual([]);
    expect(await store.exists(skill.path)).toBe(false);
  });

  it('is refused, and keeps the note, when an agent that uses it has a broken link', async () => {
    const { store, coder, skill } = await setup();
    const plain = await brokenLink(store, coder);
    await store.patchAgent(coder, { skills: [skill.path, plain] });
    await expect(deleteSkill(store, skill)).rejects.toThrow('does not resolve');
    expect(await store.exists(skill.path)).toBe(true);
  });

  it('only trashes skill, chat, project and schedule notes', async () => {
    const { store } = await setup();
    await expect(store.trashNote('Mesa/Agents/Coder.md')).rejects.toThrow(
      'can be trashed here',
    );
  });
});
