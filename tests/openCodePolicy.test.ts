import { describe, expect, it } from 'vitest';
import {
  openCodeEnvironment,
  openCodePolicyProblem,
} from '../src/core/runtimes/openCode';
import type { RunRequest } from '../src/core/runtimes/types';

const request: RunRequest = {
  prompt: '',
  systemPrompt: '',
  cwd: 'C:/state',
  sessionId: '',
  resume: false,
  permission: 'edit',
  protectedPaths: [],
};

/** The effective config OpenCode prints when Mesa's settings are in force. */
function effective(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    formatter: false,
    lsp: false,
    snapshot: false,
    mcp: {},
    instructions: [],
    agent: {
      agenthq: {
        mode: 'primary',
        permission: JSON.parse(env.OPENCODE_PERMISSION!) as unknown,
      },
    },
    ...overrides,
  });
}

describe('OpenCode effective policy', () => {
  const env = openCodeEnvironment(request, 'C:/state');

  it('matches Mesa when OpenCode prints the expected policy', () => {
    expect(openCodePolicyProblem(effective(env), env)).toBeUndefined();
  });

  it('refuses when a formatter or an MCP server is enabled', () => {
    expect(
      openCodePolicyProblem(effective(env, { formatter: true }), env),
    ).toContain('differs from Mesa');
    expect(
      openCodePolicyProblem(effective(env, { mcp: { github: {} } }), env),
    ).toContain('differs from Mesa');
  });
});

describe('OpenCode browser policy', () => {
  const launch = {
    node: 'C:/node/node.exe',
    server: 'C:/tools/cli.js',
    browser: 'C:/pw/chrome.exe',
    cache: 'C:/pw',
    helper: 'C:/vault/plugin/browser_mcp.cjs',
    runDir: 'C:/tmp/run',
  };
  const env = openCodeEnvironment(
    { ...request, browserLaunch: launch },
    'C:/s',
  );
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as {
    mcp: Record<string, { command: string[] }>;
  };

  it('loads exactly Mesa’s helper as the one server and allows only its tools', () => {
    expect(Object.keys(config.mcp)).toEqual(['playwright']);
    expect(config.mcp.playwright!.command.slice(0, 3)).toEqual([
      'C:/node/node.exe',
      'C:/vault/plugin/browser_mcp.cjs',
      '--agenthq-browser',
    ]);
    expect(JSON.parse(env.OPENCODE_PERMISSION!)).toMatchObject({
      '*': 'deny',
      'playwright_*': 'allow',
    });
    // A run without the browser has no server and no extra permission.
    const plain = openCodeEnvironment(request, 'C:/s');
    expect(JSON.parse(plain.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      mcp: {},
    });
    expect(JSON.parse(plain.OPENCODE_PERMISSION!)).not.toHaveProperty(
      'playwright_*',
    );
  });

  it('accepts exactly that entry and refuses any other, extra or changed server', () => {
    expect(
      openCodePolicyProblem(effective(env, { mcp: config.mcp }), env),
    ).toBeUndefined();
    const changed = (mcp: unknown) =>
      openCodePolicyProblem(effective(env, { mcp }), env);
    expect(changed({})).toContain('differs');
    expect(changed({ ...config.mcp, github: {} })).toContain('differs');
    expect(
      changed({
        playwright: { ...config.mcp.playwright, command: ['evil.exe'] },
      }),
    ).toContain('differs');
    // And a run without the browser still refuses the browser entry.
    const plain = openCodeEnvironment(request, 'C:/s');
    expect(
      openCodePolicyProblem(effective(plain, { mcp: config.mcp }), plain),
    ).toContain('differs');
  });
});
