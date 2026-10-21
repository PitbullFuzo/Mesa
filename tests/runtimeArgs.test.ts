import { expect, it } from 'vitest';
import { buildRuntimeArgs } from '../src/core/runtimes/claudeCode';
import type { RunRequest } from '../src/core/runtimes/types';

const request: RunRequest = {
  prompt: 'do not execute $(touch nope) & echo nope',
  systemPrompt: 'system',
  cwd: 'C:/vault/Notes',
  sessionId: 'a05d12f5-5b75-4b92-8296-9c43288d8182',
  resume: false,
  permission: 'edit',
  protectedPaths: ['C:/vault/.obsidian', 'C:/vault/Obi-I/Agents'],
  extraDirs: ['C:/other'],
  model: 'small',
};

it('passes only the isolated Playwright MCP for opted-in confined agents', () => {
  const browserLaunch = {
    node: 'C:/node/node.exe',
    helper: 'C:/plugin/browser_mcp.cjs',
    server: 'C:/tools/cli.js',
    browser: 'C:/cache/chrome.exe',
    cache: 'C:/cache',
    runDir: 'C:/temp/run',
  };
  const args = buildRuntimeArgs(
    {
      ...request,
      canUseBrowser: true,
      browserEngine: 'playwright',
      browserLaunch,
    },
    'C:/temp/system.txt',
  );
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  expect(args).not.toContain('--safe-mode');
  expect(args).toContain('--restricted');
  expect(args).toContain('--disable-slash-commands');
  expect(args).toContain('--no-chrome');
  expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({
    disableAllHooks: true,
    disableBundledSkills: true,
    autoMemoryEnabled: false,
    enableWorkflows: false,
    disableClaudeAiConnectors: true,
    claudeMdExcludes: ['**'],
  });
  expect(Object.keys(config.mcpServers)).toEqual(['playwright']);
  expect(config.mcpServers.playwright?.args).toContain('--isolated');
  expect(args[args.indexOf('--allowedTools') + 1]).toContain(
    'mcp__playwright__*',
  );
  expect(args).not.toContain('mcp__*');
  expect(args).not.toContain('--chrome');
  expect(args).toContain('--strict-mcp-config');
  for (const patch of [
    { wholeComputerReadConfirmed: true },
    { browserEngine: 'hermes' as const },
  ])
    expect(() =>
      buildRuntimeArgs(
        { ...request, canUseBrowser: true, browserLaunch, ...patch },
        'system.txt',
      ),
    ).toThrow();
  const off = buildRuntimeArgs(
    { ...request, browserLaunch, canUseBrowser: false },
    'system.txt',
  );
  expect(off[off.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
});
it.each([
  { ...request, permission: 'full' as const },
  { ...request, protectedPaths: undefined },
  { ...request, protectedPaths: [] },
  { ...request, protectedPaths: ['relative'] },
  { ...request, protectedPaths: ['C:/vault/*/Agents'] },
  { ...request, protectedPaths: ['C:/vault/./Obi-I/Agents'] },
  { ...request, protectedPaths: ['C:/vault/Obi-I/Agents.'] },
  { ...request, protectedPaths: ['C:/vault/Obi-I/Agents '] },
  { ...request, cwd: 'relative' },
  { ...request, extraDirs: ['relative'] },
  { ...request, sessionId: '--resume' },
])('refuses unsafe requests before spawn %#', (unsafe) => {
  expect(() => buildRuntimeArgs(unsafe, 'C:/temp/system.txt')).toThrow();
});

it('keeps read-only tools read-only and resumes using the same session ID', () => {
  const args = buildRuntimeArgs(
    {
      ...request,
      permission: 'read-only',
      resume: true,
    },
    'C:/temp/system.txt',
  );
  expect(args).not.toContain('--session-id');
  expect(args[args.indexOf('--resume') + 1]).toBe(request.sessionId);
  expect(args[args.indexOf('--tools') + 1]).toBe(
    'Read,Glob,Grep,WebSearch,WebFetch',
  );
});

it('builds a scoped, shell-free edit launch with a small tool surface and protected-path denials', () => {
  const args = buildRuntimeArgs(request, 'C:/temp/system.txt');
  expect(args).toContain('--restricted');
  expect(args).toContain('--safe-mode');
  expect(args).toContain('--strict-mcp-config');
  expect(args).toContain('--include-partial-messages');
  expect(args).toContain('--verbose');
  expect(args).toContain('--print');
  expect(args).toContain('--session-id');
  expect(args).toContain('--append-system-prompt-file');
  expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(
    'C:/temp/system.txt',
  );
  expect(args).toContain('Edit(//c/vault/Obi-I/Agents)');
  expect(args).toContain('Edit(//c/vault/Obi-I/Agents/**)');
  expect(args.some((arg) => /^(Write|NotebookEdit)\(/.test(arg))).toBe(false);
  expect(args).not.toContain(request.prompt);
  expect(args).not.toContain(request.systemPrompt);
  expect(args[args.indexOf('--tools') + 1]).toBe(
    'Read,Glob,Grep,WebSearch,WebFetch,Edit,Write',
  );
  expect(args).not.toContain('--dangerously-skip-permissions');
  expect(args).not.toContain('--bare');
});
