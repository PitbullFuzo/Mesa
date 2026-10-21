import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { checkSetup, setupLine } from '../src/core/setupCheck';
import type { RuntimeAdapter, RuntimeStatus } from '../src/core/runtimes/types';
import { obiPrompt } from '../src/core/obi';
import { WorkspaceController } from '../src/obsidian/workspaceController';

vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
}));

function adapter(
  id: string,
  displayName: string,
  status: RuntimeStatus | Error,
): RuntimeAdapter {
  return {
    id,
    displayName,
    detect: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
    start: () => ({ stop: async () => undefined }),
  } as unknown as RuntimeAdapter;
}

describe('the setup check', () => {
  it('reports ready, missing and wrong-version tools, and skips the fake runtime', async () => {
    const checks = await checkSetup(
      [
        adapter('claude-code', 'Claude Code', {
          available: true,
          version: '2.1.0',
        }),
        adapter('hermes', 'Hermes', { available: false }),
        adapter('codex', 'Codex', {
          available: false,
          version: 'codex-cli 0.150.0',
          blocked: true,
          hint: 'Codex 0.160.0 or newer is required. Older versions are blocked.',
        }),
        adapter('fake', 'Fake', { available: true }),
      ],
      async () => '20.1.0',
    );
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['claude-code', 'ready'],
      ['hermes', 'missing'],
      ['codex', 'wrong-version'],
      ['node', 'ready'],
    ]);
    // The wrong-version line names Codex, the version found, and the version Codex needs.
    expect(checks[2]!.detail).toContain('codex-cli 0.150.0');
    expect(checks[2]!.detail).toContain('Codex 0.160.0 or newer');
    expect(setupLine(checks[2]!)).toContain('Codex: wrong version');
    expect(setupLine(checks[0]!)).toBe('Claude Code: ready (2.1.0)');
  });

  it('treats a tool whose detection throws as missing, and Node.js as missing when it cannot run', async () => {
    const checks = await checkSetup(
      [adapter('opencode', 'OpenCode', new Error('boom'))],
      async () => undefined,
    );
    expect(checks.map((check) => check.status)).toEqual(['missing', 'missing']);
    expect(checks[1]!.install).toContain('https://nodejs.org');
    expect(setupLine(checks[1]!)).toContain('Node.js: missing');
  });

  it('shows the note on a newer Codex that passed the self-test, next to its version', async () => {
    const [codex] = await checkSetup(
      [
        adapter('codex', 'Codex', {
          available: true,
          version: 'codex-cli 0.163.0',
          hint: 'Checked by Obi-I, not yet verified by the developer (codex 0.163.0).',
        }),
      ],
      async () => undefined,
    );
    expect(codex!.status).toBe('ready');
    expect(setupLine(codex!)).toContain('codex-cli 0.163.0; Checked by Obi-I');
  });

  it('calls a found but not ready tool unavailable, never a wrong version', async () => {
    const [claude] = await checkSetup(
      [
        adapter('claude-code', 'Claude Code', {
          available: false,
          version: '2.1.0',
          hint: 'Sign in to Claude Code first.',
        }),
      ],
      async () => undefined,
    );
    expect(claude!.status).toBe('unavailable');
    expect(claude!.detail).toBe('Sign in to Claude Code first.');
    expect(setupLine(claude!)).toBe(
      'Claude Code: found but not ready (Sign in to Claude Code first.) — ' +
        claude!.install,
    );
  });

  it('uses the same Node.js finder as the browser tools', async () => {
    const checks = await checkSetup([], async () => '22.0.0');
    expect(checks).toEqual([
      expect.objectContaining({
        id: 'node',
        status: 'ready',
        detail: '22.0.0',
      }),
    ]);
  });

  it('lets Obi answer what is missing from the same list', () => {
    const prompt = obiPrompt([], [], {
      setup: [
        {
          id: 'hermes',
          label: 'Hermes',
          status: 'missing',
          detail: 'not found',
          install: 'Install Hermes.',
        },
      ],
    });
    expect(prompt).toContain('## Setup check');
    expect(prompt).toContain('- Hermes: missing — Install Hermes.');
  });

  it('the controller keeps the result, and the checking flag is cleared afterwards', async () => {
    const workspace = new WorkspaceController(
      {} as App,
      () => {},
      async () => [],
      async () => {},
      async () => [
        {
          id: 'node',
          label: 'Node.js',
          status: 'ready',
          detail: '20.1.0',
          install: '',
        },
      ],
    );
    const seen: boolean[] = [];
    workspace.subscribe(() =>
      seen.push(workspace.getSnapshot().setupChecking === true),
    );
    await workspace.runSetupCheck();
    expect(seen).toEqual([true, false]);
    expect(workspace.getSnapshot().setup?.[0]?.id).toBe('node');
  });
});
