import recorded from './fixtures/codex-permissions.json';
import { describe, expect, it } from 'vitest';
import {
  buildCodexArgs,
  findCodex,
  CodexParser,
} from '../src/core/runtimes/codex';
import type { RunEvent } from '../src/core/runtimes/types';
import type { RunRequest } from '../src/core/runtimes/types';
it('replays real Windows JSONL at byte boundaries, reporting usage but not invented dollar cost', () => {
  for (const [name, frames] of Object.entries(recorded)) {
    const events: RunEvent[] = [];
    const parser = new CodexParser((e) => events.push(e));
    const bytes = Buffer.from(
      frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
    );
    for (let i = 0; i < bytes.length; i += 7)
      parser.push(bytes.subarray(i, i + 7));
    parser.end();
    expect(events[0]).toMatchObject({ type: 'session' });
    if (name === 'permissions')
      expect(events.at(-1)).toMatchObject({
        isError: true,
        text: expect.stringContaining('Code Mode') as unknown,
      });
    else {
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        isError: false,
        text: expect.stringContaining('s12-denied.md') as unknown,
      });
      expect(
        events.filter(
          (e) => e.type === 'tool' && e.name === 'command_execution',
        ),
      ).toHaveLength(1);
      expect(events.some((e) => e.type === 'tool' && e.name === 'Usage')).toBe(
        true,
      );
    }
    expect(events.at(-1)).not.toHaveProperty('costUsd');
  }
});
const req: RunRequest = {
  cwd: 'C:/Vault/HQ/Work/a',
  prompt: 'secret prompt',
  systemPrompt: 'secret instructions',
  sessionId: '11111111-1111-4111-8111-111111111111',
  resume: false,
  permission: 'edit',
  extraDirs: ['C:/Vault/HQ/Work', 'C:/Vault/HQ/Attachments'],
  protectedPaths: [
    'C:/Vault/.obsidian',
    'C:/Vault/HQ/Agents',
    'C:/Vault/HQ/Tasks',
    'C:/Vault/HQ/Activity',
    'C:/Vault/HQ/Attachments',
  ],
  wholeComputerReadConfirmed: true,
};
it('resolves native desktop and macOS Codex without executing a shell shim', async () => {
  expect(
    (
      await findCodex({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:/Local', PATH: 'C:/npm' },
        exists: async (p) =>
          p.replace(/\\/g, '/') === 'C:/Local/Programs/OpenAI/Codex/bin/codex',
      })
    )?.file.replace(/\\/g, '/'),
  ).toBe('C:/Local/Programs/OpenAI/Codex/bin/codex');
  expect(
    (
      await findCodex({
        platform: 'darwin',
        env: { HOME: '/u', PATH: '' },
        exists: async (p) => p === '/opt/homebrew/bin/codex',
      })
    )?.file,
  ).toBe('/opt/homebrew/bin/codex');
  expect(
    await findCodex({
      platform: 'win32',
      env: { PATH: 'C:/npm' },
      exists: async (p) =>
        [
          'C:/npm/codex.cmd',
          'C:/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe',
        ].includes(p.replace(/\\/g, '/')),
    }),
  ).toMatchObject({ file: expect.stringContaining('codex.exe') as unknown });
  expect(
    await findCodex({
      platform: 'win32',
      env: { PATH: 'C:/npm' },
      exists: async (p) => p.endsWith('codex.cmd'),
    }),
  ).toBeUndefined();
});
describe('Codex browser', () => {
  const launch = {
    node: 'C:/node/node.exe',
    server: 'C:/tools/cli.js',
    browser: 'C:/pw/chrome.exe',
    cache: 'C:/pw',
    helper: 'C:/vault/plugin/browser_mcp.cjs',
    runDir: 'C:/tmp/run',
  };
  const browser = {
    ...req,
    canUseBrowser: true,
    browserReadsConfirmed: true,
    browserLaunch: launch,
  };
  it('loads exactly Mesa’s helper for that run and nothing else', () => {
    const args = buildCodexArgs(browser);
    expect(args).toContain('mcp_servers={}');
    expect(args).toContain(
      'mcp_servers.agenthq_browser.command="C:/node/node.exe"',
    );
    expect(args.filter((a) => a.startsWith('mcp_servers.'))).toHaveLength(2);
    expect(
      args.find((a) => a.startsWith('mcp_servers.agenthq_browser.args=')),
    ).toContain('--agenthq-browser');
    expect(buildCodexArgs(req).some((a) => a.includes('agenthq_browser'))).toBe(
      false,
    );
  });
  it('is refused without its own tick box, without the browser tools and with another engine', () => {
    expect(() =>
      buildCodexArgs({ ...browser, browserReadsConfirmed: false }),
    ).toThrow(/Tick/);
    expect(() =>
      buildCodexArgs({ ...browser, browserLaunch: undefined }),
    ).toThrow(/Set up browser tools/);
    expect(() =>
      buildCodexArgs({ ...browser, browserEngine: 'hermes' }),
    ).toThrow(/Hermes browser/);
  });
});
it('requires explicit broad-read consent, denies full and refuses broad writable roots', () => {
  expect(() =>
    buildCodexArgs({ ...req, wholeComputerReadConfirmed: false }),
  ).toThrow(/whole computer|confirm/);
  expect(() => buildCodexArgs({ ...req, permission: 'full' })).toThrow(/Full/);
  for (const extraDirs of [['C:/Vault'], ['C:/Vault/HQ']])
    expect(() => buildCodexArgs({ ...req, extraDirs })).toThrow(/protected/);
  expect(() =>
    buildCodexArgs({ ...req, cwd: 'C:/Vault/HQ/Agents/sub' }),
  ).toThrow(/protected/);
  expect(() => buildCodexArgs({ ...req, cwd: 'C:/Vault' })).toThrow(
    /protected/,
  );
});
it('uses workspace-write, no approvals/network/MCP, never makes Attachments writable and carries no prompt bodies in args', () => {
  const args = buildCodexArgs(req);
  expect(args).toContain('workspace-write');
  expect(args).toContain('--ignore-user-config');
  expect(args).toContain('--ignore-rules');
  expect(args).toContain('approval_policy="never"');
  expect(args).toContain('sandbox_workspace_write.network_access=false');
  expect(args).toContain('features.code_mode_host=true');
  expect(args).toContain('features.code_mode=false');
  expect(args).toContain('mcp_servers={}');
  expect(args).not.toContain('C:/Vault/HQ/Attachments');
  expect(args.join(' ')).not.toContain('secret');
  expect(args.at(-1)).toBe('-');
  const resumed = buildCodexArgs({
    ...req,
    resume: true,
    permission: 'read-only',
    webAccess: false,
  });
  expect(resumed).toContain('read-only');
  expect(resumed).toContain('resume');
  expect(resumed).toContain(req.sessionId);
  expect(resumed).toContain('web_search="disabled"');
  expect(resumed).not.toContain('--add-dir');
});
it('parses byte-fragmented sessions, cumulative message updates, tools and unknown-dollar token usage', () => {
  const events: RunEvent[] = [];
  const parser = new CodexParser((e) => events.push(e));
  const frames = [
    { type: 'thread.started', thread_id: req.sessionId },
    {
      type: 'item.started',
      item: { id: 't', type: 'command_execution', command: 'read fixture' },
    },
    {
      type: 'item.completed',
      item: {
        id: 't',
        type: 'command_execution',
        command: 'read fixture',
        exit_code: 1,
      },
    },
    {
      type: 'item.updated',
      item: { id: 'm', type: 'agent_message', text: 'Hi ' },
    },
    {
      type: 'item.completed',
      item: { id: 'm', type: 'agent_message', text: 'Hi 世界' },
    },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
  ];
  const bytes = Buffer.from(
    frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
  for (let i = 0; i < bytes.length; i += 3)
    parser.push(bytes.subarray(i, i + 3));
  parser.end();
  expect(
    events
      .filter((e) => e.type === 'text')
      .map((e) => (e.type === 'text' ? e.text : ''))
      .join(''),
  ).toBe('Hi 世界');
  expect(events[0]).toEqual({ type: 'session', sessionId: req.sessionId });
  expect(
    events.filter((e) => e.type === 'tool' && e.name === 'command_execution'),
  ).toHaveLength(1);
  expect(events.at(-1)).toEqual({
    type: 'done',
    text: 'Hi 世界',
    isError: false,
    tokens: { input: 10, output: 3 },
    context: { used: 13 },
  });
});
it('fails a native item-level startup error instead of accepting a later turn.completed', () => {
  const events: RunEvent[] = [];
  const p = new CodexParser((e) => events.push(e));
  p.push(
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'e',
        type: 'error',
        message: 'Code Mode is unavailable because code-mode host is disabled.',
      },
    }) +
      '\n' +
      JSON.stringify({ type: 'turn.completed', usage: {} }) +
      '\n',
  );
  expect(events.at(-1)).toMatchObject({
    type: 'done',
    isError: true,
    text: expect.stringContaining('Code Mode') as unknown,
  });
});
it.each([
  '{bad\n',
  JSON.stringify({
    type: 'turn.failed',
    error: { message: 'Authentication required' },
  }) + '\n',
])('fails malformed or native failed turns without inventing costs', (line) => {
  const events: RunEvent[] = [];
  const p = new CodexParser((e) => events.push(e));
  p.push(line);
  p.end();
  expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
  expect(events.at(-1)).not.toHaveProperty('costUsd');
});
