import { describe, expect, it } from 'vitest';
import type { Agent, Group, Skill } from '../src/core/model';
import { MemoryStore } from '../src/core/memoryStore';
import { projectAssignmentLabel } from '../src/core/projects';
import { initializeStarterTeam } from '../src/core/starter';
import {
  archiveProject,
  projectSlug,
  createProjectNote,
  loadValidProjects,
  projectsForAgents,
  parseProject,
  pickableProjects,
  projectPromptSection,
  updateProjectNote,
  type Project,
} from '../src/core/projects';

const agent = (id: string, group: string | null) =>
  ({ id, name: id, group }) as Agent;
const groups: Group[] = [{ id: 'core', name: 'Core team', color: '#7c3aed' }];
const agents = [
  agent('ceo', null),
  agent('coder', 'core'),
  agent('scribe', null),
];
const skills: Skill[] = [
  { path: 'Skills/sales.md', name: 'Sales playbook', body: 'Pitch steps.' },
] as Skill[];

async function loadAll(store: MemoryStore): Promise<Project[]> {
  const notes = await store.loadProjects();
  return notes
    .map((note) => parseProject(note))
    .filter((entry): entry is Project => 'name' in entry);
}

describe('project notes', () => {
  it('creates a note that parses as a project, and never overwrites a name', async () => {
    const store = new MemoryStore('Obi-I');
    const first = await createProjectNote(store, 'Obi-I', {
      name: 'Sales X',
      goal: 'Win Q4',
      instructions: 'Be direct.',
    });
    const second = await createProjectNote(store, 'Obi-I', {
      name: 'Sales X',
    });
    expect(first).toBe('Obi-I/Projects/Sales X.md');
    expect(second).toBe('Obi-I/Projects/Sales X (2).md');
    const [project] = (await loadAll(store)).filter(
      (entry) => entry.name === 'Sales X',
    );
    expect(project).toMatchObject({
      status: 'planned',
      goal: 'Win Q4',
      instructions: 'Be direct.',
      archived: false,
    });
  });

  it('edits fields and keeps the instructions unless they are changed', async () => {
    const store = new MemoryStore('Obi-I');
    await createProjectNote(store, 'Obi-I', {
      name: 'P',
      instructions: 'Keep me.',
    });
    const [project] = await loadAll(store);
    await updateProjectNote(store, project!, {
      status: 'active',
      goal: 'New goal',
    });
    const [after] = await loadAll(store);
    expect(after).toMatchObject({
      status: 'active',
      goal: 'New goal',
      instructions: 'Keep me.',
    });
  });

  it('archives a project so the picker no longer offers it', async () => {
    const store = new MemoryStore('Obi-I');
    await createProjectNote(store, 'Obi-I', { name: 'Old' });
    const [project] = await loadAll(store);
    await updateProjectNote(store, project!, { teams: ['core'] });
    const [assigned] = await loadAll(store);
    expect(pickableProjects([assigned!], 'coder', agents, groups)).toHaveLength(
      1,
    );
    await archiveProject(store, assigned!);
    const [archived] = await loadAll(store);
    expect(archived?.archived).toBe(true);
    expect(pickableProjects([archived!], 'coder', agents, groups)).toEqual([]);
  });

  it('rejects a note with an unknown status instead of showing a project', () => {
    const problem = parseProject({
      path: 'Obi-I/Projects/Bad.md',
      name: 'Bad',
      frontmatter: { agenthq: 'project', id: 'x', status: 'stuck' },
      body: '',
    });
    expect(problem).toHaveProperty('problem');
  });

  it('is created by the starter team', async () => {
    const store = new MemoryStore('Obi-I');
    await initializeStarterTeam(store, 'Obi-I');
    expect(await store.exists('Obi-I/Projects')).toBe(true);
  });
});

describe('project assignment and skills', () => {
  const base = {
    agenthq: 'project',
    id: 'p',
    status: 'active',
    goal: '',
    teams: [] as string[],
    agents: [] as string[],
    skills: [] as string[],
    archived: false,
    contextLevels: {},
  } as const;

  it('lets the picker offer only agents assigned directly or through a team', () => {
    const project = {
      ...base,
      name: 'P',
      path: 'p',
      instructions: '',
      teams: ['core'],
      agents: ['scribe'],
    } as Project;
    expect(pickableProjects([project], 'coder', agents, groups)).toHaveLength(
      1,
    );
    expect(pickableProjects([project], 'scribe', agents, groups)).toHaveLength(
      1,
    );
    expect(pickableProjects([project], 'ceo', agents, groups)).toEqual([]);
  });

  it('adds project skills only to runs of that project by an assigned agent', () => {
    const project = {
      ...base,
      name: 'Sales X',
      path: 'p',
      instructions: 'Sell.',
      goal: 'Q4',
      teams: [],
      agents: ['coder'],
      skills: ['Skills/sales.md'],
    } as Project;
    const inProject = projectPromptSection(
      project,
      'coder',
      agents,
      groups,
      skills,
    );
    expect(inProject).toContain('## Project: Sales X');
    expect(inProject).toContain('Pitch steps.');
    expect(projectPromptSection(project, 'ceo', agents, groups, skills)).toBe(
      '',
    );
    expect(projectPromptSection(null, 'coder', agents, groups, skills)).toBe(
      '',
    );
  });

  it('keeps project skills out of an archived project', () => {
    const project = {
      ...base,
      name: 'Old',
      path: 'p',
      instructions: '',
      teams: [],
      agents: ['coder'],
      skills: ['Skills/sales.md'],
      archived: true,
    } as Project;
    expect(projectPromptSection(project, 'coder', agents, groups, skills)).toBe(
      '',
    );
  });
});

describe('project picker sources', () => {
  const base = {
    agenthq: 'project',
    id: 'p',
    status: 'active',
    goal: '',
    deadline: undefined,
    costLimitUsd: undefined,
    teams: [] as string[],
    agents: [] as string[],
    skills: [] as string[],
    archived: false,
    contextLevels: {},
    instructions: '',
  } as const;
  it('offers a broadcast target only the projects where one of its agents is assigned', () => {
    const sales = {
      ...base,
      id: 's',
      name: 'Sales',
      path: 's',
      agents: ['scribe'],
    } as unknown as Project;
    const build = {
      ...base,
      id: 'b',
      name: 'Build',
      path: 'b',
      teams: ['core'],
    } as unknown as Project;
    const onlyCeo = projectsForAgents([sales, build], ['ceo'], agents, groups);
    expect(onlyCeo).toEqual([]);
    expect(
      projectsForAgents([sales, build], ['scribe'], agents, groups),
    ).toEqual([sales]);
    expect(
      projectsForAgents([sales, build], ['coder'], agents, groups),
    ).toEqual([build]);
  });
  it('keeps only valid project notes', () => {
    const valid = {
      path: 'Obi-I/Projects/Ok.md',
      name: 'Ok',
      frontmatter: { agenthq: 'project', id: 'ok', status: 'planned' },
      body: '',
    };
    const broken = {
      path: 'Obi-I/Projects/Bad.md',
      name: 'Bad',
      frontmatter: { agenthq: 'project', id: 'bad', status: 'stuck' },
      body: '',
    };
    expect(
      loadValidProjects([valid, broken]).map((project) => project.name),
    ).toEqual(['Ok']);
  });
});

describe('Projects folder and page labels', () => {
  it('creates the Projects folder for a vault that lacks it, then the project', async () => {
    const store = new MemoryStore('Team');
    await store.createFolder('Team');
    const path = await createProjectNote(store, 'Team', { name: 'Launch' });
    expect(store.folders.has('Team/Projects')).toBe(true);
    expect(path).toBe('Team/Projects/Launch.md');
  });

  it('labels assignments by team and agent name, or as not assigned', () => {
    const [assigned, free] = loadValidProjects([
      {
        name: 'Launch',
        path: 'Team/Projects/Launch.md',
        frontmatter: {
          agenthq: 'project',
          id: 'p1',
          status: 'active',
          teams: ['core'],
          agents: ['coder'],
        },
        body: '',
      },
      {
        name: 'Idea',
        path: 'Team/Projects/Idea.md',
        frontmatter: { agenthq: 'project', id: 'p2', status: 'planned' },
        body: '',
      },
    ]);
    const agents = [{ id: 'coder', name: 'Coder' } as Agent];
    const groups: Group[] = [
      { id: 'core', name: 'Core team', color: '#7c3aed' },
    ];
    expect(projectAssignmentLabel(assigned!, agents, groups)).toBe(
      'Teams: Core team · Agents: Coder',
    );
    expect(projectAssignmentLabel(free!, agents, groups)).toBe('Not assigned');
  });
});

describe('project file names', () => {
  it('strips path separators, control characters and characters Obsidian refuses', () => {
    expect(projectSlug('a\\b')).toBe('ab');
    expect(projectSlug('a/b:c*d?')).toBe('abcd');
    expect(projectSlug('tab\there\u0007')).toBe('tabhere');
  });

  it('removes leading and trailing dots and spaces, and falls back to a plain name', () => {
    expect(projectSlug('..secret')).toBe('secret');
    expect(projectSlug('  Launch.  ')).toBe('Launch');
    expect(projectSlug('...')).toBe('Project');
    expect(projectSlug('   ')).toBe('Project');
  });

  it('cuts long names to 80 characters without leaving a trailing space or dot', () => {
    const slug = projectSlug('word '.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith(' ')).toBe(false);
  });
});
