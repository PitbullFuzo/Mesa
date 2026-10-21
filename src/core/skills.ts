import type { Agent, Skill } from './model';
import {
  loadValidProjects,
  projectSlug,
  updateProjectNote,
  type Project,
} from './projects';
import type { Store } from './store';

/** The link target's name: "[[Folder/karpathy-guidelines.md|Alias]]" gives "karpathy-guidelines". */
export function linkTargetName(link: string): string {
  const inner = link.replace(/^\[\[/, '').replace(/\]\]$/, '');
  const target = inner.split('|')[0]!.split('#')[0]!.trim();
  return (target.split('/').pop() ?? target).replace(/\.md$/, '');
}

/** Whether an agent link or project path refers to this skill. */
export function refersTo(reference: string, skill: Skill): boolean {
  return reference === skill.path || linkTargetName(reference) === skill.name;
}

/** The skill's description: its frontmatter description, else its first line of text that is not a heading. */
export function skillDescription(skill: Skill): string {
  if (skill.description?.trim()) return skill.description.trim();
  const line = skill.body
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !entry.startsWith('#'));
  return line ? line.slice(0, 140) : '';
}

/** Words and a rough token estimate (about 1.3 tokens a word) of what the skill adds to a prompt. */
export function skillSize(skill: Skill): { words: number; tokens: number } {
  const words = skill.body.split(/\s+/).filter((word) => word !== '').length;
  return { words, tokens: Math.ceil(words * 1.3) };
}

/** Agents and projects that reference the skill. */
export function skillUsers(
  skill: Skill,
  agents: Agent[],
  projects: Project[],
): { agents: Agent[]; projects: Project[] } {
  return {
    agents: agents.filter((agent) =>
      agent.skills.some((link) => refersTo(link, skill)),
    ),
    projects: projects.filter((project) =>
      project.skills.some((path) => refersTo(path, skill)),
    ),
  };
}

/** The skill paths an agent references, or the links that do not resolve to any skill. */
function resolveAgentSkills(
  agent: Agent,
  skills: Skill[],
): { paths: string[]; unresolved: string[] } {
  const paths: string[] = [];
  const unresolved: string[] = [];
  for (const link of agent.skills) {
    const hit = skills.find((skill) => refersTo(link, skill));
    if (hit) paths.push(hit.path);
    else unresolved.push(link);
  }
  return { paths, unresolved };
}

/** Creates a skill note in Mesa/Skills, never overwriting an existing one. */
export async function createSkillNote(
  store: Store,
  root: string,
  input: { name: string; description: string; instructions: string },
): Promise<string> {
  const folder = `${root}/Skills`;
  if (!(await store.exists(folder))) await store.createFolder(folder);
  const base = projectSlug(input.name);
  let path = `${folder}/${base}.md`;
  for (let suffix = 2; await store.exists(path); suffix++)
    path = `${folder}/${base} (${suffix}).md`;
  await store.createNote(
    path,
    { description: input.description },
    input.instructions,
  );
  return path;
}

/** Edits a skill's description and instructions. Its name, which is its file name, does not change. */
export async function updateSkillNote(
  store: Store,
  skill: Skill,
  patch: { description?: string; instructions?: string },
): Promise<void> {
  const note = await store.loadNote(skill.path);
  if (!note) throw new Error('That skill could not be read.');
  const frontmatter = { ...(note.frontmatter as Record<string, unknown>) };
  if (patch.description !== undefined)
    frontmatter.description = patch.description;
  await store.saveNote(
    skill.path,
    frontmatter,
    patch.instructions ?? note.body,
  );
}

/**
 * Adds or removes a skill for agents and projects, through the same patch paths Setup and the project form use.
 * An agent with a link that does not resolve is refused, so no reference is dropped silently.
 */
export async function assignSkill(
  store: Store,
  skill: Skill,
  change: { agentIds: string[]; projectIds: string[]; add: boolean },
): Promise<void> {
  const skills = await store.loadSkills();
  const agents = (await store.loadAgents()).agents;
  for (const id of change.agentIds) {
    const agent = agents.find((entry) => entry.id === id);
    if (!agent) continue;
    const { paths, unresolved } = resolveAgentSkills(agent, skills);
    if (unresolved.length)
      throw new Error(
        `${agent.name} has a skill link that does not resolve (${unresolved[0]}). Fix it in Setup first.`,
      );
    const next = change.add
      ? [...new Set([...paths, skill.path])]
      : paths.filter((path) => path !== skill.path);
    await store.patchAgent(id, { skills: next });
  }
  const projects = loadValidProjects(await store.loadProjects());
  for (const id of change.projectIds) {
    const project = projects.find((entry) => entry.id === id);
    if (!project) continue;
    const kept = project.skills.filter(
      (reference) => !refersTo(reference, skill),
    );
    const next = change.add ? [...new Set([...kept, skill.path])] : kept;
    await updateProjectNote(store, project, { skills: next });
  }
}

/**
 * Deletes a skill: the agents and projects that use it lose the reference first, then the note is trashed.
 * Refused while an agent has a skill link that does not resolve.
 */
export async function deleteSkill(store: Store, skill: Skill): Promise<void> {
  const agents = (await store.loadAgents()).agents;
  const projects = loadValidProjects(await store.loadProjects());
  const users = skillUsers(skill, agents, projects);
  await assignSkill(store, skill, {
    agentIds: users.agents.map((agent) => agent.id),
    projectIds: users.projects.map((project) => project.id),
    add: false,
  });
  await store.trashNote(skill.path);
}
