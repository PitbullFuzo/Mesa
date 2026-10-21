import { z } from 'zod';
import type { Agent, Group, Skill } from './model';
import type { AgentSetupPatch } from './setup';
import type { Store } from './store';
import {
  applyProjectAction,
  describeProjectAction,
  isProjectAction,
  projectActionProblem,
  projectActionRefusal,
  projectActionSchema,
  type ObiProjectSnapshot,
  type ProjectOps,
} from './obiProjects';
import {
  applySkillAction,
  describeSkillAction,
  isSkillAction,
  skillActionProblem,
  skillActionSchema,
  type SkillOps,
} from './obiSkills';
import type { Project } from './projects';
import { describeRule, type Schedule } from './schedules';
import { GUIDE_BODY } from './guide';
import { setupNeeds } from './setupNeeds';
import { setupLine, type ToolCheck } from './setupCheck';

/** Obi: the built-in assistant. Its note is `Obi.md` (id `obi`); the dot in the label is display only. */
export const OBI_ID = 'obi';
export const OBI_NAME = 'Obi';
export const OBI_LABEL = 'Obi';
export const OBI_ROLE = 'Your Mesa assistant';

const OBI_INSTRUCTIONS =
  'You are Obi, the general assistant for this Obsidian vault and the Mesa plugin. Answer questions about notes and about how Mesa works, using the Mesa guide skill. You may propose changes to the team, but you never make them yourself: the owner approves each change. You do not delegate tasks; your job is the team.';

export const OBI_GUIDE = `# Mesa guide

Mesa runs AI agents inside Obsidian. Each agent is a note in the Mesa folder, and each team member is an agent.

- **Agents** are notes in Mesa/Agents. Their role, instructions, runtime, model, permission, vault and web access, manager and group live in the note.
- **Groups** organise the team on the AI Graph. Groups have a name and a colour.
- **Managers** (reportsTo) decide who can delegate work to whom. Only direct reports receive delegated tasks.
- **Delegation** happens when a manager ends a reply with an agenthq-delegate block. Results come back automatically.
- **Verify loop**: a verifier checks a worker's answer and returns pass or fail. Failed work goes to the Inbox.
- **Chat** is per agent. New conversations summarise the old one; past conversations can be continued from History.
- **Permissions**: read-only and edit are the agent levels. Full permission is not available. Protected folders (Mesa Agents, Tasks, Activity and the plugin config) cannot be edited by agents.
- **Access**: vault access is off, read or write per agent (write is owner-only). Web access and browser control are owner-only in Setup. Whole-computer reads are owner-only and need explicit consent.
- **Safety**: real replies use your installed runtime account and may cost money. Stop and Stop all cancel running work. Deleting chat history moves notes to the trash.
`;

const ADMIN_INSTRUCTIONS = `## Team changes
To propose changes, end your reply with exactly one fenced block. Nothing is applied until the owner approves each action.
\`\`\`agenthq-admin
{"actions":[{"type":"createGroup","name":"Research","color":"#2563eb"},{"type":"createAgent","name":"Researcher","role":"Analyst","instructions":"Short instructions.","group":"Research","reportsTo":"CEO"}]}
\`\`\`
Allowed actions: createAgent (name, role, instructions, group, reportsTo, model, runtime, permission read-only or edit, vaultAccess off or read, webAccess false), updateAgent (id, role, instructions, skills, reportsTo, group, model, runtime), createGroup (name, color as #rrggbb), renameGroup (id, name), setManager (id, managerId or null).
Refer to agents and groups by name or id from the snapshot. Never propose full permission, vault write, whole-computer reads, browser control, or web access on; the owner sets those in Setup. Deleting agents or groups is not offered.
When you propose agents, groups or a team, tell the owner in your reply what each agent will need turned on in its Setup, using the guide section "What each agent needs", and name the exact place (for example "Open Writer → Setup → Web access"). You never turn these on yourself.

## Project and schedule changes
Project actions: createProject (name, goal, instructions, status planned/active/ongoing/paused/done, teams, agents, skills by name, costLimitUsd), updateProject (id = project name; goal, instructions, status, teams, agents, skills, contextLevels, costLimitUsd).
Schedule actions: createSchedule (name, agent, project, message, rule, costCapUsd required), updateSchedule (id = schedule name; enabled, rule, message, project, costCapUsd, missedRun).
Rules: {"kind":"daily","time":"09:00"}, {"kind":"weekdays","time":"09:00"}, {"kind":"weekly","day":1,"time":"09:00"} (0 = Sunday), {"kind":"every","hours":4}.
A new schedule always starts paused; the owner enables it. You may lower a cost limit or cap, never raise or remove one: the plugin refuses those.
Project and schedule changes also need one approval each. Deleting projects or schedules is not offered.

## Skill changes
Skill actions: createSkill (name, description, instructions), updateSkill (id = skill name; description and/or instructions), assignSkill (skill = skill name; agents and projects by name; adds only). Each needs one approval. Deleting a skill or taking one away is not offered; the owner does that on the Skills page.

Propose as soon as the request is clear enough. When the owner leaves a goal, instructions or a skill open, choose a sensible one from the snapshot and say what you chose in one sentence. Never ask for a skill, a goal or a cost cap: pick a sensible value yourself (a schedule cap of 0.25 USD is a good default) and say what you picked. Ask a question only when an action cannot be made without an answer.`;

/** Team snapshot and admin rules, appended to Obi's prompt on every run. No secrets and no paths. */
export function obiPrompt(
  agents: Agent[],
  groups: Group[],
  extra: {
    projects?: Project[];
    schedules?: Schedule[];
    skills?: Skill[];
    setup?: ToolCheck[];
  } = {},
): string {
  const name = (id: string | null) =>
    id === null
      ? 'none'
      : (agents.find((agent) => agent.id === id)?.name ?? id);
  const group = (id: string | null) =>
    id === null
      ? 'none'
      : (groups.find((entry) => entry.id === id)?.name ?? id);
  const roster = agents.map(
    (agent) =>
      `- ${agent.name} (id ${agent.id}): ${agent.role || 'no role'}; runtime ${agent.runtime}; reports to ${name(agent.reportsTo)}; group ${group(agent.group)}; permission ${agent.permission}; vault ${agent.vaultAccess}; web ${agent.webAccess ? 'on' : 'off'}`,
  );
  return [
    '## Team snapshot',
    ...(roster.length ? roster : ['- no agents']),
    '## Groups',
    ...(groups.length
      ? groups.map((entry) => `- ${entry.name} (id ${entry.id})`)
      : ['- none']),
    '## Skills',
    ...((extra.skills ?? []).length
      ? (extra.skills ?? []).map((skill) => `- ${skill.name}`)
      : ['- none']),
    '## Projects',
    ...((extra.projects ?? []).length
      ? (extra.projects ?? []).map(
          (project) =>
            `- ${project.name} (id ${project.id}): status ${project.status}; teams ${project.teams.map(group).join(', ') || 'none'}; agents ${project.agents.map(name).join(', ') || 'none'}; cost limit ${project.costLimitUsd === undefined ? 'none' : '$' + project.costLimitUsd}`,
        )
      : ['- none']),
    '## Schedules',
    ...((extra.schedules ?? []).length
      ? (extra.schedules ?? []).map(
          (schedule) =>
            `- ${schedule.name}: agent ${name(schedule.agentId)}; project ${(extra.projects ?? []).find((project) => project.id === schedule.projectId)?.name ?? 'none'}; ${describeRule(schedule.rule)}; ${schedule.held ? 'held' : schedule.enabled ? 'enabled' : 'paused'}; cost cap per run ${schedule.costCapUsd === undefined ? 'none' : '$' + schedule.costCapUsd}`,
        )
      : ['- none']),
    GUIDE_BODY,
    ...(extra.setup
      ? [
          '## Setup check',
          'When the owner asks what is missing, answer from this list and give the install line for each missing tool.',
          ...extra.setup.map((check) => `- ${setupLine(check)}`),
        ]
      : []),
    ADMIN_INSTRUCTIONS,
  ].join('\n');
}

/** The display name used in panels: Obi shows its label, every other agent its name. */
export function agentDisplayName(agent: Agent): string {
  return agent.id === OBI_ID ? OBI_LABEL : agent.name;
}

const runtimeId = z.enum(['claude-code', 'hermes', 'codex', 'opencode']);
const reference = z.string().trim().min(1).max(120);
const text = (max: number) => z.string().max(max);
const agentFields = {
  role: text(200).optional(),
  instructions: text(4000).optional(),
  model: text(120).optional(),
  runtime: runtimeId.optional(),
  reportsTo: reference.nullable().optional(),
  group: reference.nullable().optional(),
  webAccess: z.literal(false).optional(),
};
const agentActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('createAgent'),
      name: z.string().trim().min(1).max(60),
      ...agentFields,
      permission: z.enum(['read-only', 'edit']).optional(),
      vaultAccess: z.enum(['off', 'read']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('updateAgent'),
      id: reference,
      ...agentFields,
      skills: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('createGroup'),
      name: z.string().trim().min(1).max(60),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal('renameGroup'),
      id: reference,
      name: z.string().trim().min(1).max(60),
    })
    .strict(),
  z
    .object({
      type: z.literal('setManager'),
      id: reference,
      managerId: reference.nullable(),
    })
    .strict(),
]);
export const obiActionSchema = z.union([
  agentActionSchema,
  projectActionSchema,
  skillActionSchema,
]);
export type ObiAction = z.infer<typeof obiActionSchema>;

export interface ObiField {
  label: string;
  value: string;
}
/** Long text (instructions) is shown in full as plain text; `open` says whether it starts expanded. */
export interface ObiText {
  label: string;
  text: string;
  open: boolean;
}
export interface ObiDescription {
  title: string;
  fields: ObiField[];
  texts: ObiText[];
}
export interface ObiProposal extends ObiDescription {
  id: string;
  action: ObiAction;
}

/** Fields Obi may never set; the reason is shown to the owner and reported back to Obi. */
const FORBIDDEN: Record<string, (value: unknown) => string | null> = {
  permission: (value) =>
    value === 'full'
      ? 'Obi cannot grant full permission; set it in Setup.'
      : null,
  vaultAccess: (value) =>
    value === 'write'
      ? 'Obi cannot grant vault write access; set it in Setup.'
      : null,
  webAccess: (value) =>
    value === true ? 'Obi cannot turn on web access; set it in Setup.' : null,
  wholeComputerReadConfirmed: () =>
    'Obi cannot confirm whole-computer reads; that stays in Setup.',
  browserReadsConfirmed: () =>
    'Obi cannot confirm browser use with whole-computer reads; that stays in Setup.',
  noteTypes: () =>
    'Obi cannot choose where an agent writes notes; set Note types in Setup.',
  canUseM365: () => 'Obi cannot enable Microsoft 365; that stays in Setup.',
  canUseBrowser: () =>
    'Obi cannot enable browser control; that stays in Setup.',
  runCommands: (value) =>
    value === 'allow' || value === 'ask'
      ? 'Obi cannot allow commands; set Run commands in Setup.'
      : null,
};

function forbiddenReason(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  for (const [key, check] of Object.entries(FORBIDDEN)) {
    if (!(key in raw)) continue;
    const reason = check((raw as Record<string, unknown>)[key]);
    if (reason) return reason;
  }
  return null;
}

const LONG_TEXT_LINES = 15;

/** Everything an approval card must show: each field before and after, and the full instructions. */
export function describeAction(
  action: ObiAction,
  snapshot: ObiProjectSnapshot,
): ObiDescription {
  if (isProjectAction(action)) return describeProjectAction(action, snapshot);
  if (isSkillAction(action)) return describeSkillAction(action, snapshot);
  const { agents, groups } = snapshot;
  const agentLabel = (ref: string | null) => {
    if (ref === null) return 'none';
    const hit = agents.find(
      (agent) =>
        agent.id === ref || agent.name.toLowerCase() === ref.toLowerCase(),
    );
    return hit ? agentDisplayName(hit) : `${ref} (not found)`;
  };
  const groupLabel = (ref: string | null) => {
    if (ref === null) return 'none';
    const hit = groups.find(
      (group) =>
        group.id === ref || group.name.toLowerCase() === ref.toLowerCase(),
    );
    return hit ? hit.name : `${ref} (not found)`;
  };
  const field = (label: string, value: string): ObiField => ({ label, value });
  const longText = (text: string) =>
    text.split(/\r?\n/).length < LONG_TEXT_LINES;
  switch (action.type) {
    case 'createAgent':
      return {
        title: `Create agent “${action.name}”`,
        fields: [
          field('Name', action.name),
          field('Role', action.role ?? 'not set'),
          field(
            'Group',
            action.group === undefined ? 'not set' : groupLabel(action.group),
          ),
          field(
            'Manager',
            action.reportsTo === undefined
              ? 'not set'
              : agentLabel(action.reportsTo),
          ),
          field('Runtime', action.runtime ?? 'Mesa default'),
          field('Model', action.model || 'Mesa default'),
          field('Permission', action.permission ?? 'Mesa default'),
          field('Vault access', action.vaultAccess ?? 'Mesa default'),
          field('Web access', 'off'),
          ...(setupNeeds(action.name, action.role, action.instructions).length
            ? [
                field(
                  'You will need to turn on',
                  setupNeeds(
                    action.name,
                    action.role,
                    action.instructions,
                  ).join('; '),
                ),
              ]
            : []),
        ],
        texts: [
          {
            label: 'Instructions',
            text: action.instructions ?? '(not set)',
            open: longText(action.instructions ?? ''),
          },
        ],
      };
    case 'updateAgent': {
      const target = agents.find(
        (agent) =>
          agent.id === action.id ||
          agent.name.toLowerCase() === action.id.toLowerCase(),
      );
      const fields: ObiField[] = [];
      const texts: ObiText[] = [];
      const change = (label: string, before: string, after: string) =>
        fields.push(field(label, `${before} → ${after}`));
      if (action.role !== undefined)
        change('Role', target?.role ?? '', action.role);
      if (action.model !== undefined)
        change('Model', target?.model || 'default', action.model || 'default');
      if (action.runtime !== undefined)
        change('Runtime', target?.runtime ?? '', action.runtime);
      if (action.group !== undefined)
        change(
          'Group',
          groupLabel(target?.group ?? null),
          action.group === null ? 'none' : groupLabel(action.group),
        );
      if (action.reportsTo !== undefined)
        change(
          'Manager',
          agentLabel(target?.reportsTo ?? null),
          action.reportsTo === null ? 'none' : agentLabel(action.reportsTo),
        );
      if (action.skills !== undefined) {
        const before = target?.skills ?? [];
        fields.push(
          field(
            'Skills added',
            action.skills
              .filter((skill) => !before.includes(skill))
              .join(', ') || 'none',
          ),
        );
        fields.push(
          field(
            'Skills removed',
            before
              .filter((skill) => !action.skills!.includes(skill))
              .join(', ') || 'none',
          ),
        );
      }
      if (action.webAccess === false) fields.push(field('Web access', 'off'));
      if (action.instructions !== undefined) {
        texts.push({
          label: 'Instructions (new)',
          text: action.instructions,
          open: longText(action.instructions),
        });
        texts.push({
          label: 'Instructions (current)',
          text: target?.instructions ?? '',
          open: false,
        });
      }
      return {
        title: `Update ${target ? agentDisplayName(target) : `${action.id} (not found)`}`,
        fields: fields.length ? fields : [field('Change', 'none')],
        texts,
      };
    }
    case 'createGroup':
      return {
        title: `Create group “${action.name}”`,
        fields: [field('Name', action.name), field('Colour', action.color)],
        texts: [],
      };
    case 'renameGroup': {
      const current = groups.find(
        (group) =>
          group.id === action.id ||
          group.name.toLowerCase() === action.id.toLowerCase(),
      );
      return {
        title: `Rename group “${current?.name ?? action.id}”`,
        fields: [
          field('Name', `${current?.name ?? action.id} → ${action.name}`),
        ],
        texts: [],
      };
    }
    case 'setManager': {
      const target = agents.find(
        (agent) =>
          agent.id === action.id ||
          agent.name.toLowerCase() === action.id.toLowerCase(),
      );
      return {
        title: `Set manager of ${target ? agentDisplayName(target) : action.id}`,
        fields: [
          field(
            'Manager',
            `${agentLabel(target?.reportsTo ?? null)} → ${action.managerId === null ? 'none' : agentLabel(action.managerId)}`,
          ),
        ],
        texts: [],
      };
    }
  }
}

/** Splits a reply's last agenthq-admin block into proposals (one per action) and problems to report back. */
export function parseObiProposals(
  reply: string,
  snapshot: ObiProjectSnapshot = { agents: [], groups: [] },
): { proposals: ObiProposal[]; problems: string[] } {
  const block = [
    ...reply.matchAll(/```agenthq-admin[ \t]*\n([\s\S]*?)\n```/g),
  ].at(-1);
  if (!block) return { proposals: [], problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(block[1]!);
  } catch {
    return {
      proposals: [],
      problems: [
        'The agenthq-admin block is not valid JSON, so nothing was proposed.',
      ],
    };
  }
  const list = z.object({ actions: z.array(z.unknown()) }).safeParse(data);
  if (!list.success)
    return {
      proposals: [],
      problems: ['The agenthq-admin block needs an "actions" list.'],
    };
  const proposals: ObiProposal[] = [];
  const problems: string[] = [];
  // A schedule may name a project that this same reply creates: count those names as known while checking.
  const pendingProjects = list.data.actions.flatMap((raw) => {
    const named = raw as { type?: unknown; name?: unknown } | null;
    return named &&
      named.type === 'createProject' &&
      typeof named.name === 'string'
      ? [named.name]
      : [];
  });
  // A skill may be created by this reply and assigned in the same reply: count those names as known too.
  const pendingSkills = list.data.actions.flatMap((raw) => {
    const named = raw as { type?: unknown; name?: unknown } | null;
    return named &&
      named.type === 'createSkill' &&
      typeof named.name === 'string'
      ? [named.name]
      : [];
  });
  const checked: ObiProjectSnapshot = {
    ...snapshot,
    projects: [
      ...(snapshot.projects ?? []),
      ...pendingProjects.map(
        (name) =>
          ({
            id: `pending:${name}`,
            name,
            path: '',
            status: 'planned',
          }) as unknown as Project,
      ),
    ],
    skills: [
      ...(snapshot.skills ?? []),
      ...pendingSkills.map((name) => ({
        path: `pending:${name}`,
        name,
        body: '',
      })),
    ],
  };
  list.data.actions.forEach((raw, index) => {
    const forbidden = forbiddenReason(raw);
    if (forbidden) {
      problems.push(`Action ${index + 1} refused: ${forbidden}`);
      return;
    }
    const parsed = obiActionSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(
        `Action ${index + 1} was not valid: ${parsed.error.issues[0]?.message ?? 'check its fields'}.`,
      );
      return;
    }
    if (isProjectAction(parsed.data)) {
      const refusal = projectActionRefusal(parsed.data, checked);
      if (refusal) {
        problems.push(`Action ${index + 1} refused: ${refusal}`);
        return;
      }
      const problem = projectActionProblem(parsed.data, checked);
      if (problem) {
        problems.push(`Action ${index + 1} was not valid: ${problem}`);
        return;
      }
    }
    if (isSkillAction(parsed.data)) {
      const problem = skillActionProblem(parsed.data, checked);
      if (problem) {
        problems.push(`Action ${index + 1} was not valid: ${problem}`);
        return;
      }
    }
    proposals.push({
      id: `obi-${index}-${parsed.data.type}`,
      action: parsed.data,
      ...describeAction(parsed.data, checked),
    });
  });
  return { proposals, problems };
}

export interface ObiOps {
  snapshot(): ObiProjectSnapshot;
  /** Project and schedule operations; present in the plugin, absent in the team-only tests. */
  projects?: ProjectOps;
  /** Skill operations; present in the plugin, absent in the team-only tests. */
  skills?: SkillOps;
  createAgent(name: string): Promise<string>;
  updateAgent(id: string, patch: AgentSetupPatch): Promise<void>;
  createGroup(name: string, color: string): Promise<string>;
  renameGroup(id: string, name: string): Promise<void>;
  setManager(id: string, managerId: string | null): Promise<void>;
}

function resolveAgent(ref: string, agents: Agent[]): string {
  const found =
    agents.find((agent) => agent.id === ref) ??
    agents.find((agent) => agent.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new Error(`No agent called “${ref}”.`);
  return found.id;
}

function resolveGroup(ref: string, groups: Group[]): string {
  const found =
    groups.find((group) => group.id === ref) ??
    groups.find((group) => group.name.toLowerCase() === ref.toLowerCase());
  if (!found) throw new Error(`No group called “${ref}”.`);
  return found.id;
}

/**
 * Applies one approved action through the same controller functions Setup uses.
 * References are resolved by id or name against the snapshot as it is right now.
 */
export async function applyObiAction(
  action: ObiAction,
  ops: ObiOps,
): Promise<void> {
  if (isProjectAction(action)) {
    if (!ops.projects)
      throw new Error('Projects and schedules cannot be changed here.');
    await applyProjectAction(action, ops.snapshot(), ops.projects);
    return;
  }
  if (isSkillAction(action)) {
    if (!ops.skills) throw new Error('Skills cannot be changed here.');
    await applySkillAction(action, ops.snapshot(), ops.skills);
    return;
  }
  switch (action.type) {
    case 'createGroup':
      await ops.createGroup(action.name, action.color);
      return;
    case 'renameGroup':
      await ops.renameGroup(
        resolveGroup(action.id, ops.snapshot().groups),
        action.name,
      );
      return;
    case 'setManager': {
      const { agents } = ops.snapshot();
      await ops.setManager(
        resolveAgent(action.id, agents),
        action.managerId === null
          ? null
          : resolveAgent(action.managerId, agents),
      );
      return;
    }
    case 'updateAgent': {
      const { agents, groups } = ops.snapshot();
      const id = resolveAgent(action.id, agents);
      await patchAgent(id, action, groups, agents, ops);
      return;
    }
    case 'createAgent': {
      const id = await ops.createAgent(action.name);
      const { agents, groups } = ops.snapshot();
      await patchAgent(id, action, groups, agents, ops);
      return;
    }
  }
}

async function patchAgent(
  id: string,
  action: Extract<ObiAction, { type: 'updateAgent' | 'createAgent' }>,
  groups: Group[],
  agents: Agent[],
  ops: ObiOps,
): Promise<void> {
  const patch: AgentSetupPatch = {};
  if (action.role !== undefined) patch.role = action.role;
  if (action.instructions !== undefined)
    patch.instructions = action.instructions;
  if (action.model !== undefined) patch.model = action.model;
  if (action.runtime !== undefined) patch.runtime = action.runtime;
  if (action.group !== undefined)
    patch.group =
      action.group === null ? null : resolveGroup(action.group, groups);
  if ('permission' in action && action.permission !== undefined)
    patch.permission = action.permission;
  if ('vaultAccess' in action && action.vaultAccess !== undefined)
    patch.vaultAccess = action.vaultAccess;
  if ('skills' in action && action.skills !== undefined)
    patch.skills = action.skills;
  if (Object.keys(patch).length) await ops.updateAgent(id, patch);
  if (action.reportsTo !== undefined)
    await ops.setManager(
      id,
      action.reportsTo === null ? null : resolveAgent(action.reportsTo, agents),
    );
}

/** Creates Obi and its guide skill once, if they are missing. Existing notes are never overwritten. */
export async function ensureObi(store: Store, root: string): Promise<boolean> {
  const { agents } = await store.loadAgents();
  if (agents.some((agent) => agent.id === OBI_ID)) return false;
  const guide = `${root}/Skills/Mesa guide.md`;
  if (!(await store.exists(guide)))
    await store.createNote(
      guide,
      { agenthq: 'skill', name: 'Mesa guide' },
      OBI_GUIDE,
    );
  const path = `${root}/Agents/${OBI_NAME}.md`;
  if (await store.exists(path)) return false;
  await store.createNote(
    path,
    {
      agenthq: 'agent',
      id: OBI_ID,
      role: OBI_ROLE,
      reportsTo: null,
      runtime: 'claude-code',
      model: '',
      workdir: '',
      permission: 'read-only',
      vaultAccess: 'read',
      webAccess: false,
      group: null,
      verifier: null,
      skills: ['[[Mesa guide]]'],
    },
    OBI_INSTRUCTIONS,
  );
  return true;
}
