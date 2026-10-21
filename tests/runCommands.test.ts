import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { GUIDE_BODY } from '../src/core/guide';
import { parseObiProposals } from '../src/core/obi';
import { MemoryStore } from '../src/core/memoryStore';
import { parseAgentNotes } from '../src/core/notes';
import { FakeRuntime } from '../src/core/runtimes/fake';
import { buildCodexArgs } from '../src/core/runtimes/codex';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import { commandsOffered } from '../src/core/runtimes/ids';
import { openCodeEnvironment } from '../src/core/runtimes/openCode';
import type { RunRequest, RuntimeAdapter } from '../src/core/runtimes/types';

const SESSION = '11111111-1111-4111-8111-111111111111';
const claude = (runCommands?: boolean): RunRequest => ({
  prompt: 'continue',
  systemPrompt: 'system',
  cwd: 'C:/vault/Obi-I/Work/coder',
  sessionId: SESSION,
  resume: false,
  permission: 'edit',
  protectedPaths: ['C:/vault/.obsidian'],
  runCommands,
});

describe('Claude Code: Bash and PowerShell only when Allow freely is on', () => {
  it('Off disallows Bash and PowerShell, so no command tool is available', () => {
    const args = buildRuntimeArgs(claude(false), 'C:/system.txt');
    expect(args).toContain('Bash');
    expect(args).toContain('PowerShell');
    expect(args.join(' ')).not.toContain('Bash,PowerShell');
  });

  it('Allow freely offers Bash and PowerShell and does not disallow them', () => {
    const args = buildRuntimeArgs(claude(true), 'C:/system.txt');
    expect(args.some((entry) => entry === 'Bash')).toBe(false);
    expect(args.some((entry) => entry.split(',').includes('Bash'))).toBe(true);
    expect(args.some((entry) => entry.split(',').includes('PowerShell'))).toBe(
      true,
    );
  });
});

describe('Codex: Off stays sandboxed, Allow freely removes the sandbox', () => {
  const codex = (runCommands?: boolean): RunRequest => ({
    wholeComputerReadConfirmed: true,
    cwd: 'C:/Vault/Work',
    prompt: 'continue',
    systemPrompt: 'system',
    sessionId: SESSION,
    resume: false,
    permission: 'edit',
    protectedPaths: ['C:/Vault/.obsidian'],
    runCommands,
  });
  const sandbox = (args: string[]) => args[args.indexOf('-s') + 1];

  it('Off and unset keep the sandbox and leave the shell features alone', () => {
    for (const setting of [undefined, false]) {
      const args = buildCodexArgs(codex(setting));
      expect(sandbox(args)).toBe('workspace-write');
      expect(args.join(' ')).not.toContain('features.shell_tool');
      expect(args.join(' ')).not.toContain('features.unified_exec');
    }
    expect(
      sandbox(buildCodexArgs({ ...codex(false), permission: 'read-only' })),
    ).toBe('read-only');
  });
  it('Allow freely runs without the sandbox, whatever the edit permission', () => {
    for (const permission of ['edit', 'read-only'] as const)
      expect(sandbox(buildCodexArgs({ ...codex(true), permission }))).toBe(
        'danger-full-access',
      );
  });
});

describe('which runtimes can offer Allow freely', () => {
  it('all four can; Off stays the default', () => {
    for (const runtime of ['claude-code', 'opencode', 'hermes', 'codex'])
      expect(commandsOffered(runtime)).toBe(true);
    expect(commandsOffered('future')).toBe(false);
  });
});

describe('OpenCode: the bash permission only when Allow freely is on', () => {
  const request = (runCommands?: boolean): RunRequest => ({
    prompt: '',
    systemPrompt: '',
    cwd: 'C:/state',
    sessionId: '',
    resume: false,
    permission: 'edit',
    protectedPaths: [],
    runCommands,
  });

  it('Off denies bash; Allow freely allows it', () => {
    const off = JSON.parse(
      openCodeEnvironment(request(false), 'C:/state').OPENCODE_PERMISSION!,
    ) as { bash: string };
    const on = JSON.parse(
      openCodeEnvironment(request(true), 'C:/state').OPENCODE_PERMISSION!,
    ) as { bash: string };
    expect(off.bash).toBe('deny');
    expect(on.bash).toBe('allow');
  });
});

describe('the setting: off by default, and Obi cannot turn it on', () => {
  it('a new agent is created with commands off; an agent from before this version has no setting', async () => {
    const store = new MemoryStore('Obi-I');
    const id = await store.createAgent('Newcomer');
    const note = store.notes.get(`Obi-I/Agents/Newcomer.md`);
    expect(note?.frontmatter).toMatchObject({ runCommands: 'off' });
    expect(id).toBe('newcomer');
    const legacy = parseAgentNotes(
      [
        {
          path: 'Obi-I/Agents/Old.md',
          name: 'Old',
          body: '',
          frontmatter: {
            agenthq: 'agent',
            id: 'old',
            role: '',
            reportsTo: null,
            runtime: 'claude-code',
            permission: 'edit',
            group: null,
            model: '',
            vaultAccess: 'off',
            webAccess: true,
            wholeComputerReadConfirmed: false,
            canUseBrowser: false,
            workdir: '',
            verifier: null,
            skills: [],
          },
        },
      ],
      () => null,
    );
    expect(legacy.agents[0]?.runCommands).toBeUndefined();
  });

  it('Obi cannot allow commands: its proposal is refused with the reason', () => {
    const reply =
      '```agenthq-admin\n{"actions":[{"type":"updateAgent","id":"coder","runCommands":"allow"}]}\n```';
    const { proposals, problems } = parseObiProposals(reply, {
      agents: [],
      groups: [],
    });
    expect(proposals).toEqual([]);
    expect(problems.join(' ')).toContain('Obi cannot allow commands');
  });
});

describe('the run request carries the setting', () => {
  async function run(setting: 'off' | 'allow' | undefined) {
    const store = new MemoryStore('Obi-I');
    const coder = await store.createAgent('Coder');
    // Claude Code is the runtime that can offer Allow freely; the fake runtime answers for it in tests.
    await store.patchAgent(coder, { runtime: 'claude-code' });
    if (setting) await store.patchAgent(coder, { runCommands: setting });
    const fake = new FakeRuntime(
      () => [{ type: 'done', text: 'ok', isError: false, costUsd: 0 }],
      0,
    );
    const adapter: RuntimeAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      detect: () => fake.detect(),
      start: (request, onEvent) => fake.start(request, onEvent),
    };
    const service = new ChatService({
      store,
      adapters: [adapter],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Obi-I',
      memoryDelayMs: 60_000,
    });
    await service.initialize();
    await service.send(coder, 'do it');
    return fake.requests.at(-1)!.runCommands;
  }

  it('an agent without the setting runs with commands off', async () => {
    expect(await run(undefined)).toBe(false);
    expect(await run('off')).toBe(false);
  });

  it('an agent set to Allow freely runs with commands on', async () => {
    expect(await run('allow')).toBe(true);
  });
});

describe('the guide describes the setting', () => {
  it('says Off is the default, what Allow freely and Ask me each time do, and who gets which', () => {
    expect(GUIDE_BODY).toContain(
      'Run commands is off for every agent until you set it',
    );
    expect(GUIDE_BODY).toContain(
      'Allow freely lets an agent run commands as you',
    );
    expect(GUIDE_BODY).toContain(
      'Allow freely removes the sandbox: no folder limits and internet on',
    );
    expect(GUIDE_BODY).toContain('Ask me each time (OpenCode and Hermes only)');
    expect(GUIDE_BODY).toContain('they have only Off and Allow freely');
  });
});
