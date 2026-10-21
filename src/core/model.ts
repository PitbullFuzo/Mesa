import { z } from 'zod';
import { DEFAULT_RUNTIME_ID } from './runtimes/ids';

const optionalLink = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^\[\[[^[\]]+\]\]$/.test(value),
    'Expected a wiki link',
  )
  .nullish()
  .transform((value) => value || null);
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? '');

export const agentFrontmatterSchema = z.object({
  agenthq: z.literal('agent'),
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a nonempty slug'),
  role: z.string(),
  reportsTo: optionalLink,
  group: z
    .string()
    .nullish()
    .transform((value) => value || null),
  runtime: z.string().transform((value) => value || DEFAULT_RUNTIME_ID),
  model: optionalText,
  permission: z.enum(['read-only', 'edit', 'full']),
  vaultAccess: z.enum(['off', 'read', 'write']).default('off'),
  /** Commands the agent may run. Absent means off: an upgrade never grants commands. */
  runCommands: z.enum(['off', 'allow', 'ask']).optional(),
  webAccess: z.boolean().default(true),
  wholeComputerReadConfirmed: z.boolean().default(false),
  canUseBrowser: z.boolean().default(false),
  /** Microsoft 365 (mail, calendar, OneDrive) tools; off until the owner turns them on for this agent. */
  canUseM365: z.boolean().default(false),
  /** Note destinations (Settings) this agent may write: ids of note types. None by default. */
  noteTypes: z.array(z.string()).default([]),
  /** Codex only: the owner also accepts the browser together with whole-computer reads. */
  browserReadsConfirmed: z.boolean().default(false),
  workdir: optionalText,
  verifier: optionalLink,
  skills: z.array(z.string()),
  /** Outside folders this agent may use. Absent on agents made before this list existed: those keep all of them. */
  outsideFolders: z.array(z.string()).optional(),
});

export interface Agent {
  id: string;
  name: string;
  path: string;
  role: string;
  reportsTo: string | null;
  group: string | null;
  runtime: string;
  model: string;
  permission: 'read-only' | 'edit' | 'full';
  vaultAccess?: 'off' | 'read' | 'write';
  runCommands?: 'off' | 'allow' | 'ask';
  webAccess?: boolean;
  wholeComputerReadConfirmed?: boolean;
  canUseBrowser?: boolean;
  canUseM365?: boolean;
  noteTypes?: string[];
  browserReadsConfirmed?: boolean;
  workdir: string;
  verifier: string | null;
  skills: string[];
  outsideFolders?: string[];
  instructions: string;
  warnings: string[];
}

export const groupSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
});
export type Group = z.infer<typeof groupSchema>;
export interface Skill {
  path: string;
  name: string;
  body: string;
  /** The frontmatter description, when the note has one. */
  description?: string;
}
export interface InvalidAgent {
  path: string;
  name: string;
  reason: string;
}
export interface AgentCollection {
  agents: Agent[];
  invalidAgents: InvalidAgent[];
}

export const taskSchema = z.object({
  agenthq: z.literal('task'),
  from: z.string(),
  to: z.string(),
  verifier: optionalLink,
  status: z.enum([
    'queued',
    'running',
    'verifying',
    'passed',
    'failed',
    'needs-you',
    'cancelled',
  ]),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  requestId: z.string(),
  depth: z.number().int().nonnegative(),
  sessionId: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.string().min(1),
  costUsd: z.number().nonnegative().optional(),
  /** Total tokens, for runtimes that report tokens instead of dollars (Codex). Never turned into a price. */
  tokens: z.number().int().nonnegative().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
