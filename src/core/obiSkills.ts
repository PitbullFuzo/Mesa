import { z } from 'zod';
import type { Agent } from './model';
import {
  findAgent,
  findProject,
  findSkill,
  type ObiCard,
  type ObiCardField,
  type ObiCardText,
  type ObiProjectSnapshot,
} from './obiProjects';
import { skillDescription, skillUsers } from './skills';

const reference = z.string().trim().min(1).max(120);

/**
 * The skill actions. Obi creates and edits skill text and adds skills to agents and projects. It never deletes a
 * skill and never takes one away from an agent or project: those stay on the Skills page, with the owner.
 */
export const skillActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('createSkill'),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(300),
      instructions: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateSkill'),
      id: reference,
      description: z.string().trim().max(300).optional(),
      instructions: z.string().max(8000).optional(),
    })
    .strict()
    .refine(
      (action) =>
        action.description !== undefined || action.instructions !== undefined,
      { message: 'Say what to change: a description or the instructions' },
    ),
  z
    .object({
      type: z.literal('assignSkill'),
      skill: reference,
      agents: z.array(reference).optional(),
      projects: z.array(reference).optional(),
    })
    .strict()
    .refine(
      (action) =>
        (action.agents?.length ?? 0) + (action.projects?.length ?? 0) > 0,
      { message: 'Name at least one agent or project to assign the skill to' },
    ),
]);
export type SkillAction = z.infer<typeof skillActionSchema>;

export function isSkillAction(action: { type: string }): action is SkillAction {
  return (
    action.type === 'createSkill' ||
    action.type === 'updateSkill' ||
    action.type === 'assignSkill'
  );
}

/** The first skill or agent or project name in a skill action that does not exist, or null when all resolve. */
export function skillActionProblem(
  action: SkillAction,
  snapshot: ObiProjectSnapshot,
): string | null {
  if (action.type === 'createSkill') return null;
  const ref = action.type === 'updateSkill' ? action.id : action.skill;
  if (!findSkill(ref, snapshot.skills ?? []))
    return `No skill called “${ref}”.`;
  if (action.type === 'assignSkill') {
    for (const agent of action.agents ?? [])
      if (!findAgent(agent, snapshot.agents))
        return `No agent called “${agent}”.`;
    for (const project of action.projects ?? [])
      if (!findProject(project, snapshot.projects ?? []))
        return `No project called “${project}”.`;
  }
  return null;
}

const longText = (label: string, body: string): ObiCardText => ({
  label,
  text: body,
  open: body.split(/\r?\n/).length < 15,
});

/** The current items plus the ones named, with an unknown name kept visible as "not found". */
function withNamed<T extends { id: string; name: string }>(
  current: T[],
  refs: string[],
  find: (ref: string) => T | undefined,
): string[] {
  const names = new Map(current.map((item) => [item.id, item.name]));
  for (const ref of refs) {
    const hit = find(ref);
    if (hit) names.set(hit.id, hit.name);
    else names.set(`missing:${ref}`, `${ref} (not found)`);
  }
  return [...names.values()];
}

const change = (before: string[], after: string[]) =>
  `${before.join(', ') || 'none'} → ${after.join(', ') || 'none'}`;

/** The approval card for a skill action: the fields that change, and the full instructions before and after. */
export function describeSkillAction(
  action: SkillAction,
  snapshot: ObiProjectSnapshot,
): ObiCard {
  const skills = snapshot.skills ?? [];
  const projects = snapshot.projects ?? [];
  switch (action.type) {
    case 'createSkill':
      return {
        title: `Create skill “${action.name}”`,
        fields: [
          { label: 'Name', value: action.name },
          { label: 'Description', value: action.description || 'not set' },
        ],
        texts: [longText('Instructions', action.instructions)],
      };
    case 'updateSkill': {
      const target = findSkill(action.id, skills);
      const fields: ObiCardField[] = [];
      if (action.description !== undefined)
        fields.push({
          label: 'Description',
          value: `${(target ? skillDescription(target) : '') || 'none'} → ${action.description || 'none'}`,
        });
      const texts: ObiCardText[] = [];
      if (action.instructions !== undefined) {
        texts.push(
          longText('Instructions (now)', target?.body.trim() || '(empty)'),
          longText('Instructions (new)', action.instructions),
        );
      }
      return {
        title: `Update skill “${target?.name ?? action.id}”`,
        fields,
        texts,
      };
    }
    case 'assignSkill': {
      const target = findSkill(action.skill, skills);
      const users = target
        ? skillUsers(target, snapshot.agents, projects)
        : { agents: [], projects: [] };
      const agentsAfter = withNamed(users.agents, action.agents ?? [], (ref) =>
        findAgent(ref, snapshot.agents),
      );
      const projectsAfter = withNamed(
        users.projects,
        action.projects ?? [],
        (ref) => findProject(ref, projects),
      );
      return {
        title: `Assign skill “${target?.name ?? action.skill}”`,
        fields: [
          {
            label: 'Agents',
            value: change(
              users.agents.map((agent: Agent) => agent.name),
              agentsAfter,
            ),
          },
          {
            label: 'Projects',
            value: change(
              users.projects.map((project) => project.name),
              projectsAfter,
            ),
          },
        ],
        texts: [],
      };
    }
  }
}

/** What applying a skill action needs from the controller: the same functions the Skills page uses. */
export interface SkillOps {
  createSkill(input: {
    name: string;
    description: string;
    instructions: string;
  }): Promise<string>;
  updateSkill(
    path: string,
    patch: { description?: string; instructions?: string },
  ): Promise<void>;
  assignSkill(
    path: string,
    change: { agentIds: string[]; projectIds: string[]; add: boolean },
  ): Promise<void>;
}

/** Applies one approved skill action, resolving names against the snapshot as it is when the owner approves. */
export async function applySkillAction(
  action: SkillAction,
  snapshot: ObiProjectSnapshot,
  ops: SkillOps,
): Promise<void> {
  const skillPath = (ref: string) => {
    const skill = findSkill(ref, snapshot.skills ?? []);
    if (!skill) throw new Error(`No skill called “${ref}”.`);
    return skill.path;
  };
  switch (action.type) {
    case 'createSkill':
      await ops.createSkill({
        name: action.name,
        description: action.description,
        instructions: action.instructions,
      });
      return;
    case 'updateSkill': {
      const patch: { description?: string; instructions?: string } = {};
      if (action.description !== undefined)
        patch.description = action.description;
      if (action.instructions !== undefined)
        patch.instructions = action.instructions;
      await ops.updateSkill(skillPath(action.id), patch);
      return;
    }
    case 'assignSkill': {
      const agentIds = (action.agents ?? []).map((ref) => {
        const agent = findAgent(ref, snapshot.agents);
        if (!agent) throw new Error(`No agent called “${ref}”.`);
        return agent.id;
      });
      const projectIds = (action.projects ?? []).map((ref) => {
        const project = findProject(ref, snapshot.projects ?? []);
        if (!project) throw new Error(`No project called “${ref}”.`);
        return project.id;
      });
      await ops.assignSkill(skillPath(action.skill), {
        agentIds,
        projectIds,
        add: true,
      });
      return;
    }
  }
}
