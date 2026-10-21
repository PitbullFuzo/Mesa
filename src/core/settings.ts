import { z } from 'zod';
import { MEMORY_CHOICES } from './projects';
import { overviewSettingsSchema } from './overviewForce';
import { DEFAULT_NOTE_TYPES, noteTypeSchema } from './noteTypes';

const settingsSchema = z.object({
  agenthqFolder: z.string().trim().min(1).catch('Mesa'),
  allowedFolders: z.array(z.string()).catch(() => []),
  maxParallelRuns: z.number().int().positive().catch(3),
  maxDelegationDepth: z.number().int().positive().catch(3),
  maxRunsPerRequest: z.number().int().positive().catch(25),
  defaultVerifierAttempts: z.number().int().positive().catch(3),
  runtimePathOverride: z.string().catch(''),
  developerMode: z.boolean().catch(false),
  browserEngine: z.enum(['playwright', 'hermes']).catch('playwright'),
  enterToSend: z.boolean().catch(true),
  agentPanelPlacement: z.enum(['side', 'main']).catch('side'),
  obiSeeded: z.boolean().catch(false),
  /** The welcome tour was finished or declined for good ("Maybe later" does not set it). */
  /** Free sandbox self-test results for newer Codex and OpenCode versions, keyed by "tool version". */
  selfTests: z
    .record(
      z.string(),
      z.object({
        result: z.enum(['pass', 'fail']),
        detail: z.string(),
        checkedAt: z.string(),
      }),
    )
    .catch({}),
  tourDone: z.boolean().catch(false),
  disclaimerAccepted: z.boolean().catch(false),
  memoryModel: z.enum(MEMORY_CHOICES).catch('auto'),
  /** Microsoft 365: the owner's own Entra app (client) id, the account type, and the signed-in name for display. */
  m365ClientId: z.string().trim().catch(''),
  m365Authority: z.enum(['consumers', 'common']).catch('consumers'),
  m365Account: z.string().catch(''),
  /** Note destinations: note type → vault folder. */
  noteTypes: z.array(noteTypeSchema).catch(() => DEFAULT_NOTE_TYPES),
  /** The optional AI concepts pass for the graph map. Off unless the owner turns it on. */
  graphAi: z.boolean().catch(false),
  /** Model for that pass; empty uses the runtime's default (the free OpenCode model for OpenCode). */
  graphAiModel: z.string().trim().catch(''),
  /** The agent last used for "Edit selection with an agent". */
  inlineEditAgent: z.string().catch(''),
  /** How the edit preview is shown: '' decides by how much changed, or the owner's last choice. */
  inlineEditLayout: z.enum(['', 'inline', 'blocks']).catch(''),
  /** The vault overview's "Display & forces" sliders and toggles. */
  overview: overviewSettingsSchema.catch(() =>
    overviewSettingsSchema.parse({}),
  ),
});

export type AgentHQSettings = z.infer<typeof settingsSchema>;

export function loadSettings(data: unknown): AgentHQSettings {
  try {
    if (
      data !== null &&
      typeof data === 'object' &&
      (Object.getPrototypeOf(data) === Object.prototype ||
        Object.getPrototypeOf(data) === null)
    ) {
      return settingsSchema.parse(data);
    }
  } catch {
    // Unreadable or malformed saved data must not prevent plugin startup.
  }
  return settingsSchema.parse({});
}
