import { z } from 'zod';
import type { Agent, Group, Skill } from './model';
import type { NoteDocument } from './notes';
import type { Store } from './store';

export const PROJECT_STATUSES = [
  'planned',
  'active',
  'ongoing',
  'paused',
  'done',
] as const;

/** Memory model choices: automatic (cheapest available), off, or one runtime. */
export const MEMORY_CHOICES = [
  'auto',
  'off',
  'claude-code',
  'opencode',
  'codex',
  'hermes',
] as const;
export type MemoryChoice = (typeof MEMORY_CHOICES)[number];

/** How much of the project memory an agent sees on each run. */
export const CONTEXT_LEVELS = ['brief', 'brief+memory', 'full'] as const;
export type ContextLevel = (typeof CONTEXT_LEVELS)[number];
export const DEFAULT_CONTEXT_LEVEL: ContextLevel = 'brief+memory';

const projectFields = z.object({
  agenthq: z.literal('project'),
  id: z.string().min(1),
  status: z.enum(PROJECT_STATUSES),
  goal: z.string().default(''),
  deadline: z.string().optional(),
  costLimitUsd: z.number().nonnegative().optional(),
  teams: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  /** Vault folder where this project's finished work goes. Its runs may write there; drafts stay in Work. */
  outputFolder: z.string().optional(),
  archived: z.boolean().default(false),
  /** Project override of the vault's memory model; unset means inherit. */
  memoryModel: z.enum(MEMORY_CHOICES).optional(),
  contextLevels: z.record(z.string(), z.enum(CONTEXT_LEVELS)).default({}),
});
export type ProjectFields = z.infer<typeof projectFields>;

export interface Project extends ProjectFields {
  name: string;
  path: string;
  instructions: string;
}

/** Reads a Projects note. Notes that do not parse are reported, not shown as projects. */
export function parseProject(
  note: NoteDocument,
): Project | { problem: string } {
  const parsed = projectFields.safeParse(note.frontmatter);
  if (!parsed.success)
    return {
      problem: `${note.name}: ${parsed.error.issues[0]?.message ?? 'invalid project note'}`,
    };
  return {
    ...parsed.data,
    name: note.name,
    path: note.path,
    instructions: note.body.trim(),
  };
}

/**
 * A file name for a project. Strips path separators, control characters and characters Obsidian
 * refuses, and leading or trailing dots and spaces, so a name can never reach outside its folder.
 */
export function projectSlug(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- control characters are removed on purpose
    .replace(/[\u0000-\u001f\u007f:*?"<>|#^[\]/\\]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || 'Project';
}

/** Creates a project note under Obi-I/Projects, never overwriting an existing one. */
export async function createProjectNote(
  store: Store,
  root: string,
  input: { name: string; goal?: string; instructions?: string },
): Promise<string> {
  const name = projectSlug(input.name);
  let path = `${root}/Projects/${name}.md`;
  for (let suffix = 2; await store.exists(path); suffix++)
    path = `${root}/Projects/${name} (${suffix}).md`;
  const fields: ProjectFields = {
    agenthq: 'project',
    id: `project-${crypto.randomUUID()}`,
    status: 'planned',
    goal: input.goal ?? '',
    teams: [],
    agents: [],
    skills: [],
    archived: false,
    contextLevels: {},
  };
  // Vaults made before Projects existed may not have the folder yet.
  if (!(await store.exists(`${root}/Projects`)))
    await store.createFolder(`${root}/Projects`);
  await store.createNote(path, { ...fields }, input.instructions ?? '');
  return path;
}

/** Edits a project's fields and instructions; the rest of the note is kept as it is. */
export async function updateProjectNote(
  store: Store,
  project: Project,
  patch: Partial<ProjectFields> & { instructions?: string },
): Promise<void> {
  const { name: _name, path, instructions, ...fields } = project;
  const next = projectFields.parse({ ...fields, ...patch });
  // Optional fields that are unset are left out of the note, not written as empty values.
  const stored = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  );
  await store.saveNote(path, stored, patch.instructions ?? instructions);
}

/** Archiving hides a project from the picker and keeps its note. */
export function archiveProject(store: Store, project: Project): Promise<void> {
  return updateProjectNote(store, project, { archived: true });
}

/** Agents a project may run: those named directly, plus every member of its teams. Archived projects run no one. */
export function assignedAgentIds(
  project: Project,
  agents: Agent[],
  groups: Group[],
): Set<string> {
  if (project.archived) return new Set();
  const teamIds = new Set(
    project.teams.filter((id) => groups.some((group) => group.id === id)),
  );
  return new Set(
    agents
      .filter(
        (agent) =>
          project.agents.includes(agent.id) ||
          (agent.group !== null && teamIds.has(agent.group)),
      )
      .map((agent) => agent.id),
  );
}

/** Projects the picker may offer for an agent. */
export function pickableProjects(
  projects: Project[],
  agentId: string,
  agents: Agent[],
  groups: Group[],
): Project[] {
  return projects.filter((project) =>
    assignedAgentIds(project, agents, groups).has(agentId),
  );
}

/**
 * The project's instructions and project-only skills, added only when the agent is assigned to the project.
 * Outside that project these skills are never added.
 */
export function projectPromptSection(
  project: Project | null,
  agentId: string,
  agents: Agent[],
  groups: Group[],
  skills: Skill[],
): string {
  if (!project || !assignedAgentIds(project, agents, groups).has(agentId))
    return '';
  const projectSkills = skills.filter((skill) =>
    project.skills.includes(skill.path),
  );
  return [
    `## Project: ${project.name}`,
    project.goal ? `Goal: ${project.goal}` : '',
    project.instructions,
    project.outputFolder
      ? `Output folder: put finished work for this project in ${project.outputFolder}. Keep drafts and scratch files in your Work folder.`
      : '',
    ...projectSkills.map(
      (skill) => `## Project skill: ${skill.name}\n${skill.body}`,
    ),
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}

/** One line for the Projects page: the teams and agents a project is assigned to. */
export function projectAssignmentLabel(
  project: Project,
  agents: Agent[],
  groups: Group[],
): string {
  const teams = project.teams.flatMap((id) =>
    groups.filter((group) => group.id === id).map((group) => group.name),
  );
  const people = project.agents.flatMap((id) =>
    agents.filter((agent) => agent.id === id).map((agent) => agent.name),
  );
  const parts = [
    teams.length > 0 ? `Teams: ${teams.join(', ')}` : '',
    people.length > 0 ? `Agents: ${people.join(', ')}` : '',
  ].filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' · ') : 'Not assigned';
}

/** Projects assigned to at least one of these agents: what a broadcast target can use. */
export function projectsForAgents(
  projects: Project[],
  agentIds: string[],
  agents: Agent[],
  groups: Group[],
): Project[] {
  return projects.filter((project) => {
    const assigned = assignedAgentIds(project, agents, groups);
    return agentIds.some((id) => assigned.has(id));
  });
}

/** Valid project notes only; a note that fails validation is left out, not shown as a project. */
export function loadValidProjects(notes: NoteDocument[]): Project[] {
  return notes
    .map((note) => parseProject(note))
    .filter((entry): entry is Project => !('problem' in entry));
}

/** What the project form saves; `path` is set when editing an existing project. */
export interface ProjectInput extends Omit<ProjectFields, 'agenthq' | 'id'> {
  path?: string;
  name: string;
  instructions: string;
}
