import { z } from 'zod';
import type { Agent } from './model';
import type { NoteDocument } from './notes';
import { managedPath } from './paths';
import { DEFAULT_RUNTIME_ID } from './runtimes/ids';

/** Include invalid notes when reserving IDs so creating a note cannot duplicate one. */
export async function newAgentNote(
  root: string,
  name: string,
  notes: NoteDocument[],
  exists: (path: string) => Promise<boolean>,
): Promise<NoteDocument> {
  setupPatchSchema.parse({ name });
  const ids = new Set(
    notes.flatMap(({ frontmatter }) =>
      frontmatter && typeof frontmatter === 'object' && 'id' in frontmatter
        ? [frontmatter.id]
        : [],
    ),
  );
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'agent';
  let id = base;
  for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
  let basename = name;
  let path = managedPath(root, `${root}/Agents/${basename}.md`);
  for (let suffix = 2; await exists(path); suffix++) {
    basename = `${name} ${suffix}`;
    path = managedPath(root, `${root}/Agents/${basename}.md`);
  }
  return {
    path,
    name: basename,
    body: '',
    frontmatter: {
      agenthq: 'agent',
      id,
      role: '',
      reportsTo: null,
      runtime: DEFAULT_RUNTIME_ID,
      permission: 'read-only',
      group: null,
      model: '',
      vaultAccess: 'off',
      // New agents cannot run commands until the owner allows it in Setup.
      runCommands: 'off',
      webAccess: true,
      wholeComputerReadConfirmed: false,
      canUseBrowser: false,
      canUseM365: false,
      noteTypes: [],
      browserReadsConfirmed: false,
      workdir: '',
      verifier: null,
      skills: [],
      // New agents start with no outside folders; the owner ticks them in Setup.
      outsideFolders: [],
    },
  };
}

export type AgentSetupPatch = Partial<
  Pick<
    Agent,
    | 'name'
    | 'role'
    | 'runtime'
    | 'model'
    | 'permission'
    | 'vaultAccess'
    | 'outsideFolders'
    | 'runCommands'
    | 'webAccess'
    | 'wholeComputerReadConfirmed'
    | 'canUseBrowser'
    | 'canUseM365'
    | 'noteTypes'
    | 'browserReadsConfirmed'
    | 'workdir'
    | 'verifier'
    | 'group'
    | 'skills'
    | 'instructions'
  >
>;

const agentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      !['#', '^', '[', ']', '|'].some((character) => name.includes(character)),
    'Agent names cannot contain wikilink characters: # ^ [ ] |',
  )
  .refine(
    (name) =>
      name.trim() === name &&
      name !== '.' &&
      name !== '..' &&
      !/[\\/<>:"|?*]/.test(name) &&
      ![...name].some((character) => character.charCodeAt(0) < 32) &&
      !/[. ]$/.test(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
    'Expected a safe, nonblank note name',
  );

export const setupPatchSchema = z.strictObject({
  name: agentNameSchema.optional(),
  role: z.string().optional(),
  runtime: z.string().optional(),
  model: z.string().optional(),
  permission: z.enum(['read-only', 'edit', 'full']).optional(),
  vaultAccess: z.enum(['off', 'read', 'write']).optional(),
  outsideFolders: z.array(z.string().min(1)).optional(),
  runCommands: z.enum(['off', 'allow', 'ask']).optional(),
  webAccess: z.boolean().optional(),
  wholeComputerReadConfirmed: z.boolean().optional(),
  canUseBrowser: z.boolean().optional(),
  canUseM365: z.boolean().optional(),
  noteTypes: z.array(z.string()).optional(),
  browserReadsConfirmed: z.boolean().optional(),
  workdir: z.string().optional(),
  verifier: z.string().min(1).nullable().optional(),
  group: z.string().nullable().optional(),
  skills: z.array(z.string().min(1)).optional(),
  instructions: z.string().optional(),
});

/** Convert only supplied fields; unresolved snapshot fallbacks never leak to disk. */
export function agentPatchToFrontmatter(
  patch: AgentSetupPatch,
  agentLink: (id: string) => string,
  skillLink: (path: string) => string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || key === 'name' || key === 'instructions')
      continue;
    if (key === 'verifier')
      fields[key] = value === null ? null : agentLink(value as string);
    else if (key === 'skills') fields[key] = (value as string[]).map(skillLink);
    else fields[key] = value;
  }
  return fields;
}
