import { z } from 'zod';
import type { Agent, Group, Skill } from './model';
import {
  CONTEXT_LEVELS,
  PROJECT_STATUSES,
  type Project,
  type ProjectFields,
} from './projects';
import {
  describeRule,
  scheduleRuleSchema,
  type Schedule,
  type ScheduleInput,
} from './schedules';

/** What Obi's proposals are checked and described against. */
export interface ObiProjectSnapshot {
  agents: Agent[];
  groups: Group[];
  projects?: Project[];
  schedules?: Schedule[];
  skills?: Skill[];
}

export interface ObiCardField {
  label: string;
  value: string;
}
export interface ObiCardText {
  label: string;
  text: string;
  open: boolean;
}
export interface ObiCard {
  title: string;
  fields: ObiCardField[];
  texts: ObiCardText[];
}

const reference = z.string().trim().min(1).max(120);
const money = z.number().nonnegative().max(100000);
const longText = z.string().max(4000);

/**
 * The project and schedule actions. Obi never deletes, never removes a cost limit or a per-run cap, never raises
 * either, and a new schedule always starts paused: the plugin enforces this, not the prompt.
 */
export const projectActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('createProject'),
      name: z.string().trim().min(1).max(80),
      goal: z.string().max(300).optional(),
      instructions: longText.optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      teams: z.array(reference).optional(),
      agents: z.array(reference).optional(),
      skills: z.array(reference).optional(),
      costLimitUsd: money.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateProject'),
      id: reference,
      goal: z.string().max(300).optional(),
      instructions: longText.optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
      teams: z.array(reference).optional(),
      agents: z.array(reference).optional(),
      skills: z.array(reference).optional(),
      contextLevels: z.record(z.string(), z.enum(CONTEXT_LEVELS)).optional(),
      costLimitUsd: money.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('createSchedule'),
      name: z.string().trim().min(1).max(80),
      agent: reference,
      project: reference.optional(),
      message: z.string().trim().min(1).max(4000),
      rule: scheduleRuleSchema,
      costCapUsd: z.number().positive().max(100000),
      missedRun: z.enum(['skip', 'run-once']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateSchedule'),
      id: reference,
      enabled: z.boolean().optional(),
      rule: scheduleRuleSchema.optional(),
      message: z.string().trim().min(1).max(4000).optional(),
      project: reference.nullable().optional(),
      costCapUsd: money.nullable().optional(),
      missedRun: z.enum(['skip', 'run-once']).optional(),
    })
    .strict(),
]);
export type ProjectAction = z.infer<typeof projectActionSchema>;

export function isProjectAction(action: {
  type: string;
}): action is ProjectAction {
  return (
    action.type === 'createProject' ||
    action.type === 'updateProject' ||
    action.type === 'createSchedule' ||
    action.type === 'updateSchedule'
  );
}

export function findProject(
  ref: string,
  projects: Project[],
): Project | undefined {
  return projects.find(
    (project) =>
      project.id === ref ||
      project.path === ref ||
      project.name.toLowerCase() === ref.toLowerCase(),
  );
}
function findSchedule(
  ref: string,
  schedules: Schedule[],
): Schedule | undefined {
  return schedules.find(
    (schedule) =>
      schedule.path === ref ||
      schedule.name.toLowerCase() === ref.toLowerCase(),
  );
}
export function findAgent(ref: string, agents: Agent[]): Agent | undefined {
  return agents.find(
    (agent) =>
      agent.id === ref || agent.name.toLowerCase() === ref.toLowerCase(),
  );
}
function findGroup(ref: string, groups: Group[]): Group | undefined {
  return groups.find(
    (group) =>
      group.id === ref || group.name.toLowerCase() === ref.toLowerCase(),
  );
}
export function findSkill(ref: string, skills: Skill[]): Skill | undefined {
  return skills.find(
    (skill) =>
      skill.path === ref || skill.name.toLowerCase() === ref.toLowerCase(),
  );
}

/** The refusal for a cost limit or cap Obi may not set, or null when the action is allowed. */
export function projectActionRefusal(
  action: ProjectAction,
  snapshot: ObiProjectSnapshot,
): string | null {
  if (action.type === 'updateProject' && action.costLimitUsd !== undefined) {
    if (action.costLimitUsd === null)
      return 'Obi cannot remove a project cost limit; set it in the project form.';
    const current = findProject(
      action.id,
      snapshot.projects ?? [],
    )?.costLimitUsd;
    if (current !== undefined && action.costLimitUsd > current)
      return `Obi cannot raise a project cost limit ($${current} now); it can only lower it.`;
  }
  if (action.type === 'updateSchedule' && action.costCapUsd !== undefined) {
    if (action.costCapUsd === null)
      return 'Obi cannot remove a schedule per-run cap; keep it or lower it.';
    const current = findSchedule(
      action.id,
      snapshot.schedules ?? [],
    )?.costCapUsd;
    if (current !== undefined && action.costCapUsd > current)
      return `Obi cannot raise a schedule per-run cap ($${current} now); it can only lower it.`;
  }
  return null;
}

const show = (value: string | undefined | null, fallback = 'not set') =>
  value === undefined || value === null || value === '' ? fallback : value;
const money$ = (value: number | undefined) =>
  value === undefined ? 'none' : `$${value}`;

/** The approval card for a project or schedule action: each field before and after, and full text. */
export function describeProjectAction(
  action: ProjectAction,
  snapshot: ObiProjectSnapshot,
): ObiCard {
  const projects = snapshot.projects ?? [];
  const schedules = snapshot.schedules ?? [];
  const groupNames = (refs: string[]) =>
    refs
      .map(
        (ref) => findGroup(ref, snapshot.groups)?.name ?? `${ref} (not found)`,
      )
      .join(', ') || 'none';
  const agentNames = (refs: string[]) =>
    refs
      .map(
        (ref) => findAgent(ref, snapshot.agents)?.name ?? `${ref} (not found)`,
      )
      .join(', ') || 'none';
  const skillNames = (refs: string[]) =>
    refs
      .map(
        (ref) =>
          findSkill(ref, snapshot.skills ?? [])?.name ?? `${ref} (not found)`,
      )
      .join(', ') || 'none';
  const change = (before: string, after: string) => `${before} → ${after}`;
  switch (action.type) {
    case 'createProject':
      return {
        title: `Create project “${action.name}”`,
        fields: [
          { label: 'Name', value: action.name },
          { label: 'Goal', value: show(action.goal) },
          { label: 'Status', value: action.status ?? 'planned' },
          { label: 'Teams', value: groupNames(action.teams ?? []) },
          { label: 'Agents', value: agentNames(action.agents ?? []) },
          { label: 'Skills', value: skillNames(action.skills ?? []) },
          { label: 'Cost limit', value: money$(action.costLimitUsd) },
        ],
        texts: [
          {
            label: 'Instructions',
            text: action.instructions ?? '(not set)',
            open: (action.instructions ?? '').split(/\r?\n/).length < 15,
          },
        ],
      };
    case 'updateProject': {
      const target = findProject(action.id, projects);
      const fields: ObiCardField[] = [];
      if (action.goal !== undefined)
        fields.push({
          label: 'Goal',
          value: change(show(target?.goal, 'none'), show(action.goal, 'none')),
        });
      if (action.status !== undefined)
        fields.push({
          label: 'Status',
          value: change(target?.status ?? '', action.status),
        });
      if (action.teams !== undefined)
        fields.push({
          label: 'Teams',
          value: change(
            groupNames(target?.teams ?? []),
            groupNames(action.teams),
          ),
        });
      if (action.agents !== undefined)
        fields.push({
          label: 'Agents',
          value: change(
            agentNames(target?.agents ?? []),
            agentNames(action.agents),
          ),
        });
      if (action.skills !== undefined)
        fields.push({
          label: 'Skills',
          value: change(
            skillNames(target?.skills ?? []),
            skillNames(action.skills),
          ),
        });
      if (action.costLimitUsd !== undefined)
        fields.push({
          label: 'Cost limit',
          value: change(
            money$(target?.costLimitUsd),
            action.costLimitUsd === null ? 'none' : money$(action.costLimitUsd),
          ),
        });
      if (action.contextLevels !== undefined)
        fields.push({
          label: 'Context levels',
          value:
            Object.entries(action.contextLevels)
              .map(([id, level]) => `${agentNames([id])}: ${level}`)
              .join(', ') || 'none',
        });
      const texts: ObiCardText[] = [];
      if (action.instructions !== undefined)
        texts.push({
          label: 'Instructions (new)',
          text: action.instructions,
          open: action.instructions.split(/\r?\n/).length < 15,
        });
      return {
        title: `Update project “${target?.name ?? action.id}”`,
        fields,
        texts,
      };
    }
    case 'createSchedule': {
      const project = action.project
        ? findProject(action.project, projects)
        : undefined;
      return {
        title: `Create schedule “${action.name}”`,
        fields: [
          { label: 'Agent', value: agentNames([action.agent]) },
          {
            label: 'Project',
            value: action.project
              ? (project?.name ?? `${action.project} (not found)`)
              : 'none',
          },
          { label: 'Repeat', value: describeRule(action.rule) },
          { label: 'Cost cap per run', value: `$${action.costCapUsd}` },
          {
            label: 'Missed runs',
            value:
              action.missedRun === 'run-once' ? 'run once on open' : 'skip',
          },
          { label: 'Starts', value: 'paused; you enable it after approving' },
        ],
        texts: [
          {
            label: 'Message',
            text: action.message,
            open: action.message.split(/\r?\n/).length < 15,
          },
        ],
      };
    }
    case 'updateSchedule': {
      const target = findSchedule(action.id, schedules);
      const fields: ObiCardField[] = [];
      if (action.enabled !== undefined)
        fields.push({
          label: 'Enabled',
          value: change(
            target?.enabled ? 'yes' : 'no',
            action.enabled ? 'yes' : 'no',
          ),
        });
      if (action.rule !== undefined)
        fields.push({
          label: 'Repeat',
          value: change(
            target ? describeRule(target.rule) : '',
            describeRule(action.rule),
          ),
        });
      if (action.project !== undefined) {
        const before =
          projects.find((project) => project.id === target?.projectId)?.name ??
          'none';
        const after =
          action.project === null
            ? 'none'
            : (findProject(action.project, projects)?.name ??
              `${action.project} (not found)`);
        fields.push({ label: 'Project', value: change(before, after) });
      }
      if (action.costCapUsd !== undefined)
        fields.push({
          label: 'Cost cap per run',
          value: change(
            target?.costCapUsd === undefined ? 'none' : `$${target.costCapUsd}`,
            action.costCapUsd === null ? 'none' : `$${action.costCapUsd}`,
          ),
        });
      if (action.missedRun !== undefined)
        fields.push({
          label: 'Missed runs',
          value: action.missedRun === 'run-once' ? 'run once on open' : 'skip',
        });
      const texts: ObiCardText[] = [];
      if (action.message !== undefined)
        texts.push({
          label: 'Message (new)',
          text: action.message,
          open: action.message.split(/\r?\n/).length < 15,
        });
      return {
        title: `Update schedule “${target?.name ?? action.id}”`,
        fields,
        texts,
      };
    }
  }
}

/** What applying a project action needs from the controller: the same functions Setup and the UI use. */
export interface ProjectOps {
  createProject(input: {
    name: string;
    goal: string;
    instructions: string;
    status: ProjectFields['status'];
    teams: string[];
    agents: string[];
    skills: string[];
    costLimitUsd?: number;
  }): Promise<void>;
  updateProject(path: string, patch: Partial<ProjectFields>): Promise<void>;
  createSchedule(input: ScheduleInput): Promise<string>;
  patchSchedule(
    path: string,
    patch: {
      enabled?: boolean;
      rule?: Schedule['rule'];
      message?: string;
      projectId?: string;
      costCapUsd?: number;
      missedRun?: 'skip' | 'run-once';
    },
  ): Promise<void>;
}

/**
 * Applies one approved project action. The guard runs again against the current data, so an approval
 * cannot raise a cost limit even if the data changed after the proposal was made.
 */
export async function applyProjectAction(
  action: ProjectAction,
  snapshot: ObiProjectSnapshot,
  ops: ProjectOps,
): Promise<void> {
  const refusal = projectActionRefusal(action, snapshot);
  if (refusal) throw new Error(refusal);
  const projects = snapshot.projects ?? [];
  const schedules = snapshot.schedules ?? [];
  const groupIds = (refs: string[]) =>
    refs.map((ref) => {
      const group = findGroup(ref, snapshot.groups);
      if (!group) throw new Error(`No group called “${ref}”.`);
      return group.id;
    });
  const agentIds = (refs: string[]) =>
    refs.map((ref) => {
      const agent = findAgent(ref, snapshot.agents);
      if (!agent) throw new Error(`No agent called “${ref}”.`);
      return agent.id;
    });
  const skillPaths = (refs: string[]) =>
    refs.map((ref) => {
      const skill = findSkill(ref, snapshot.skills ?? []);
      if (!skill) throw new Error(`No skill called “${ref}”.`);
      return skill.path;
    });
  const projectPath = (ref: string) => {
    const project = findProject(ref, projects);
    if (!project) throw new Error(`No project called “${ref}”.`);
    return project;
  };
  switch (action.type) {
    case 'createProject':
      await ops.createProject({
        name: action.name,
        goal: action.goal ?? '',
        instructions: action.instructions ?? '',
        status: action.status ?? 'planned',
        teams: groupIds(action.teams ?? []),
        agents: agentIds(action.agents ?? []),
        skills: skillPaths(action.skills ?? []),
        costLimitUsd: action.costLimitUsd,
      });
      return;
    case 'updateProject': {
      const project = projectPath(action.id);
      const patch: Partial<ProjectFields> & { instructions?: string } = {};
      if (action.goal !== undefined) patch.goal = action.goal;
      if (action.instructions !== undefined)
        patch.instructions = action.instructions;
      if (action.status !== undefined) patch.status = action.status;
      if (action.teams !== undefined) patch.teams = groupIds(action.teams);
      if (action.agents !== undefined) patch.agents = agentIds(action.agents);
      if (action.skills !== undefined) patch.skills = skillPaths(action.skills);
      if (action.contextLevels !== undefined)
        patch.contextLevels = action.contextLevels;
      if (typeof action.costLimitUsd === 'number')
        patch.costLimitUsd = action.costLimitUsd;
      await ops.updateProject(project.path, patch);
      return;
    }
    case 'createSchedule': {
      const agentId = agentIds([action.agent])[0]!;
      const projectId = action.project
        ? projectPath(action.project).id
        : undefined;
      await ops.createSchedule({
        name: action.name,
        agentId,
        projectId,
        message: action.message,
        rule: action.rule,
        costCapUsd: action.costCapUsd,
        missedRun: action.missedRun ?? 'skip',
        enabled: false,
      });
      return;
    }
    case 'updateSchedule': {
      const target = findSchedule(action.id, schedules);
      if (!target) throw new Error(`No schedule called “${action.id}”.`);
      await ops.patchSchedule(target.path, {
        enabled: action.enabled,
        rule: action.rule,
        message: action.message,
        projectId:
          action.project === undefined
            ? undefined
            : action.project === null
              ? ''
              : projectPath(action.project).id,
        costCapUsd:
          typeof action.costCapUsd === 'number' ? action.costCapUsd : undefined,
        missedRun: action.missedRun,
      });
      return;
    }
  }
}

/**
 * The first name in a project or schedule action that does not exist in the snapshot, described for the owner
 * and for Obi, or null when every reference resolves. Such an action is reported back, not proposed.
 */
export function projectActionProblem(
  action: ProjectAction,
  snapshot: ObiProjectSnapshot,
): string | null {
  const projects = snapshot.projects ?? [];
  const schedules = snapshot.schedules ?? [];
  const missing = (kind: string, ref: string) => `No ${kind} called “${ref}”.`;
  const teamRefs = 'teams' in action ? (action.teams ?? []) : [];
  const agentRefs = 'agents' in action ? (action.agents ?? []) : [];
  const skillRefs = 'skills' in action ? (action.skills ?? []) : [];
  for (const ref of teamRefs)
    if (!findGroup(ref, snapshot.groups)) return missing('team', ref);
  for (const ref of agentRefs)
    if (!findAgent(ref, snapshot.agents)) return missing('agent', ref);
  for (const ref of skillRefs)
    if (!findSkill(ref, snapshot.skills ?? [])) return missing('skill', ref);
  switch (action.type) {
    case 'createProject':
      return null;
    case 'updateProject':
      return findProject(action.id, projects)
        ? null
        : missing('project', action.id);
    case 'createSchedule':
      if (!findAgent(action.agent, snapshot.agents))
        return missing('agent', action.agent);
      if (action.project && !findProject(action.project, projects))
        return missing('project', action.project);
      return null;
    case 'updateSchedule':
      if (!findSchedule(action.id, schedules))
        return missing('schedule', action.id);
      if (action.project && !findProject(action.project, projects))
        return missing('project', action.project);
      return null;
  }
}
