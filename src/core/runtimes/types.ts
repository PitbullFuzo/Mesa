export type RuntimeId =
  | 'claude-code'
  | 'hermes'
  | 'codex'
  | 'opencode'
  | 'openrouter'
  | 'ollama'
  | 'fake';

export interface RuntimeStatus {
  available: boolean;
  version?: string;
  path?: string;
  hint?: string;
  /** Found, but blocked by the version policy (too old, or the free self-test failed). */
  blocked?: boolean;
}

export interface RunRequest {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  /** With resume: start a new session from the resumed one (native fork). Only runtimes that support it read this. */
  forkSession?: boolean;
  /** Persisted session total: adapters with cumulative billing subtract this on resume. */
  previousCostUsd?: number;
  permission: 'read-only' | 'edit' | 'full';
  model?: string;
  extraDirs?: string[];
  /** Read-only additions; never expand edit approval. */
  readDirs?: string[];
  canUseBrowser?: boolean;
  browserEngine?: import('../browser').BrowserEngine;
  browserLaunch?: Pick<
    import('./browserTools').BrowserInstallation,
    'node' | 'server' | 'browser' | 'cache'
  > & {
    helper: string;
    runDir: string;
  };
  /** Microsoft 365 tools for this run: set by the chat service after it prepared the run's token file and outbox. */
  m365Launch?: import('../m365/launch').M365Launch;
  wholeComputerReadConfirmed?: boolean;
  /** Codex only: the browser together with whole-computer reads was confirmed for this agent. */
  browserReadsConfirmed?: boolean;
  webAccess?: boolean;
  /** Absolute directories whose contents must not be modified. */
  protectedPaths?: string[];
  /** Commands are allowed for this run (Allow freely). Undefined or false is Off: the runtime's command tools are disabled. */
  runCommands?: boolean;
  /**
   * Ask me each time: set instead of `runCommands`. The runtime asks this before every command and runs it only when
   * the answer is true. Runtimes that cannot ask never receive it (see ASK_RUNTIMES).
   */
  askCommand?: (command: { command: string; cwd: string }) => Promise<boolean>;
}

export type RunEvent =
  | { type: 'session'; sessionId: string }
  /** The plan's usage windows, when the runtime reports them (Claude Code). */
  | { type: 'plan-usage'; usage: import('../context').PlanUsage }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | {
      type: 'done';
      text: string;
      costUsd?: number;
      /** Input and output tokens, when the runtime reports tokens but not dollars (Codex). */
      tokens?: { input: number; output: number };
      /** How much of the model's context the conversation uses, when the runtime reports it. */
      context?: import('../context').ContextUse;
      isError: boolean;
      errorKind?: 'auth' | 'not-found' | 'other';
    };

export interface RuntimeAdapter {
  id: RuntimeId;
  displayName: string;
  detect(): Promise<RuntimeStatus>;
  start(
    req: RunRequest,
    onEvent: (event: RunEvent) => void,
  ): { stop(): Promise<void> };
}
