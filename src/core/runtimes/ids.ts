export const DEFAULT_RUNTIME_ID = 'claude-code';

/**
 * Runtimes that offer Allow freely. Off differs by runtime: Claude Code, OpenCode and Hermes have no command tool; Codex
 * always keeps its own sandboxed shell (turning it off broke reading files, Step 28 fix round), so for Codex Allow
 * freely means running without the sandbox.
 */
export const COMMAND_RUNTIMES: readonly string[] = [
  'claude-code',
  'opencode',
  'hermes',
  'codex',
];

/**
 * Runtimes that can ask before every command. Only where nothing runs without an approved Obi-I card: OpenCode (ACP
 * permission request) and Hermes (the shim asks before each command tool). Claude Code and Codex have no safe channel.
 */
export const ASK_RUNTIMES: readonly string[] = ['opencode', 'hermes'];

export function commandsAsk(runtime: string): boolean {
  return ASK_RUNTIMES.includes(runtime);
}

export function commandsOffered(runtime: string): boolean {
  return COMMAND_RUNTIMES.includes(runtime);
}

export const RUNTIME_OPTIONS = [
  { id: DEFAULT_RUNTIME_ID, label: 'Claude Code' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex' },
] as const;

export function runtimeReadWarning(runtime: string): string {
  return runtime === 'codex'
    ? 'Codex can read your whole computer, including notes and credentials outside allowed folders. Vault access does not confine Codex reads. Shell commands run inside its write sandbox unless Run commands is Allow freely; web access can expose data to remote search. Only enable this for an agent and provider you trust.'
    : '';
}
export function runtimeModelHint(runtime: string): string {
  if (runtime === 'codex')
    return 'Requires Codex CLI 0.160.0 or newer and your existing codex login. Use a model ID supported by your ChatGPT plan; empty uses the CLI default. Codex reports tokens, not dollar cost: replies show a token count, never a guessed price, and Codex runs do not count toward dollar cost caps. Read-only blocks writes; Edit uses workspace-write, refusing writable roots containing protected folders. Shell network is disabled unless Run commands is Allow freely; Web access controls hosted search. Whole-computer read access requires separate confirmation.';
  if (runtime === 'opencode')
    return 'Use provider/model; empty uses opencode/nemotron-3.5-lightning-free. Requires the OpenCode 1.19.1 CLI, not its desktop server. Obi-I isolates its CLI state/config; provider credentials can come from the environment, never Obi-I settings. Read/edit permissions are enforced per file; shell, native delegation, glob/grep, and custom tools are disabled. Web access enables search only: URL fetch is disabled because OpenCode cannot safely confine private-network redirects.';
  return runtime === 'hermes'
    ? 'Use provider:model, for example openrouter:google/gemini-2.5-flash-lite. Empty uses your Hermes configuration. Credentials stay in Hermes. Read-only denies all edits; edit asks Obi-I for every file change.'
    : '';
}

/** Static display only; executable detection belongs to the adapter. */
export function staticRuntimeStatus(runtime: string): 'idle' | 'offline' {
  return RUNTIME_OPTIONS.some((option) => option.id === runtime)
    ? 'idle'
    : 'offline';
}
