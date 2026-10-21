import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { AgentPanelContent } from '../src/obsidian/views/panelContent';
import { ChatContent, HistoryContent } from '../src/obsidian/views/chatContent';
import { MemoryStore } from '../src/core/memoryStore';
import { initializeStarterTeam } from '../src/core/starter';
import type { WorkspaceActions } from '../src/core/workspace';
import type { AgentChatSnapshot } from '../src/core/chat';
import { OBI_ID, parseObiProposals } from '../src/core/obi';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: vi.fn((await original<typeof import('react')>()).useState),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));
vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
}));
vi.mock('../src/obsidian/views/markdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => content,
}));

async function fixture() {
  const store = new MemoryStore('Mesa');
  await initializeStarterTeam(store, 'Mesa');
  const agent = (await store.loadAgents()).agents.find(
    (entry) => entry.id === 'coder',
  )!;
  const chat: AgentChatSnapshot = {
    agent,
    status: 'idle',
    session: null,
    history: [],
    messages: [
      {
        role: 'user',
        content: 'Question',
        timestamp: '2026-10-15T08:00:00Z',
        tools: [],
      },
      {
        role: 'assistant',
        content: '**Raw Markdown**',
        timestamp: '2026-10-15T08:00:01Z',
        tools: [],
      },
    ],
  };
  const state = {
    agents: [agent],
    selectedId: agent.id,
    agentTab: 'setup',
    enterToSend: false,
    groups: [],
    skills: [],
    chat: { agents: { [agent.id]: chat } },
  };
  const workspace = {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
  } as unknown as WorkspaceActions;
  return { agent, chat, workspace };
}

describe('Chat and Setup safety UI', () => {
  it.each(['playwright', 'hermes'] as const)(
    'disables unavailable %s browser permission with a visible setup/isolation reason',
    async (engine) => {
      const { workspace } = await fixture();
      Object.assign(workspace.getSnapshot(), {
        browser: {
          engine,
          available: false,
          hint: 'Browser isolation/setup unavailable',
        },
      });
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(html).toMatch(/aria-label="Can use browser"[^>]*disabled/);
      expect(html).toMatch(/unavailable|only for Claude/);
      expect(html).toContain('Browser engine:');
    },
  );
  it('offers ready Playwright only to confined agents and shows the opt-in risk warning', async () => {
    const { workspace, agent } = await fixture();
    Object.assign(workspace.getSnapshot(), {
      browser: { engine: 'playwright', available: true, hint: 'Ready' },
    });
    agent.canUseBrowser = true;
    let html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).not.toMatch(/aria-label="Can use browser"[^>]*disabled/);
    expect(html).toContain('fresh isolated profile');
    agent.canUseBrowser = false;
    agent.wholeComputerReadConfirmed = true;
    html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).toMatch(/aria-label="Can use browser"[^>]*disabled/);
    expect(html).toContain('whole-computer reads');
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    'warns about whole-computer reads plus web only for %s/%s',
    async (wholeComputerReadConfirmed, webAccess) => {
      const { workspace, agent } = await fixture();
      agent.runtime = 'codex';
      agent.wholeComputerReadConfirmed = wholeComputerReadConfirmed;
      agent.webAccess = webAccess;
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(
        html.includes(
          'This agent can read your whole computer and search the web; a malicious page could try to trick it into leaking files.',
        ),
      ).toBe(wholeComputerReadConfirmed && webAccess);
    },
  );
  it.each([
    ['future', true],
    ['hermes', false],
    ['claude-code', false],
  ] as const)(
    'shows the unavailable note under the Run commands select for %s: %s',
    async (runtime, shown) => {
      const { workspace, agent } = await fixture();
      agent.runtime = runtime;
      agent.runCommands = 'off';
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(html.includes('Commands are not available for this tool')).toBe(
        shown,
      );
    },
  );
  it('labels Codex Off as sandboxed and warns strongly when Allow freely is on; Allow is enabled for every runtime', async () => {
    const { workspace, agent } = await fixture();
    const render = () =>
      renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
    for (const runtime of ['claude-code', 'opencode', 'hermes', 'codex']) {
      agent.runtime = runtime;
      agent.runCommands = 'off';
      const html = render();
      expect(html).not.toMatch(/<option value="allow"[^>]*disabled/);
      expect(html.includes('Off: commands only inside its sandbox')).toBe(
        runtime === 'codex',
      );
      expect(html).toContain(
        runtime === 'codex' ? 'Codex always runs commands' : 'Off: no commands',
      );
    }
    agent.runtime = 'codex';
    agent.runCommands = 'allow';
    const html = render();
    expect(html).toContain('No folder limits and internet on');
  });
  it.each(['opencode', 'hermes', 'codex'] as const)(
    'offers the browser to %s without a refusal when the browser tools are ready',
    async (runtime) => {
      const { workspace, agent } = await fixture();
      Object.assign(workspace.getSnapshot(), {
        browser: { engine: 'playwright', available: true, hint: 'Ready' },
      });
      agent.runtime = runtime;
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(html).not.toMatch(/aria-label="Can use browser"[^>]*disabled/);
      expect(html).toContain('Isolated Playwright is ready.');
    },
  );
  it('for Codex shows its own browser tick box, the stronger warning, and a visible reason until it is ticked', async () => {
    const { workspace, agent } = await fixture();
    Object.assign(workspace.getSnapshot(), {
      browser: { engine: 'playwright', available: true, hint: 'Ready' },
    });
    agent.runtime = 'codex';
    agent.wholeComputerReadConfirmed = true;
    const render = () =>
      renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
    let html = render();
    expect(html).toContain(
      'aria-label="Allow the browser together with whole-computer reads"',
    );
    expect(html).toMatch(/aria-label="Can use browser"[^>]*disabled/);
    // The reason is a visible warning line, not only small grey help text.
    expect(html).toMatch(/class="agenthq-warning">Browser engine:[^<]*Tick/);
    agent.browserReadsConfirmed = true;
    agent.canUseBrowser = true;
    html = render();
    expect(html).not.toMatch(/aria-label="Can use browser"[^>]*disabled/);
    expect(html).toContain('a bad web page could trick it into sending');
    // Other runtimes never show the extra tick box.
    agent.runtime = 'opencode';
    agent.wholeComputerReadConfirmed = false;
    expect(render()).not.toContain('together with whole-computer reads');
  });
  it('shows the Codex whole-computer read warning and separate opt-in checkbox', async () => {
    const { workspace, agent } = await fixture();
    agent.runtime = 'codex';
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).toContain('can read your whole computer');
    expect(html).toContain('aria-label="Whole computer read access"');
  });
  it.each([
    ['off', false],
    ['off', true],
    ['read', false],
    ['read', true],
    ['write', false],
    ['write', true],
  ] as const)(
    'renders vault/web controls and warning only for %s/%s',
    async (vaultAccess, webAccess) => {
      const { workspace, agent } = await fixture();
      agent.vaultAccess = vaultAccess;
      agent.webAccess = webAccess;
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(html).toContain('aria-label="Vault access"');
      expect(html).toContain('aria-label="Web access"');
      expect(
        html.includes(
          'This agent can read your vault and the web; a malicious page could try to trick it into leaking notes.',
        ),
      ).toBe(vaultAccess !== 'off' && webAccess);
      if (vaultAccess === 'write') expect(html).toContain('Vault write access');
    },
  );
  it('allows an offline chat to submit a draft so send can re-detect on demand', async () => {
    const { chat, workspace, agent } = await fixture();
    chat.status = 'offline';
    vi.mocked(useState).mockReturnValueOnce(['hello', vi.fn()]);
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(submit).toBeDefined();
    expect(submit).not.toContain('disabled');
  });

  it('offers a Copy raw Markdown button on replies, not user messages', async () => {
    const { chat, workspace, agent } = await fixture();
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    expect(html.match(/aria-label="Copy raw Markdown"/g)).toHaveLength(1);
    expect(html).toContain('Copy');
  });
  it('disables full permission and explains existing full notes', async () => {
    const { workspace, agent } = await fixture();
    agent.permission = 'full';
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).toMatch(/<option value="full"[^>]*disabled=""/);
    expect(html).toContain('Full — not available yet');
    expect(html).toContain(
      'Full permission is not available — choose edit or read-only',
    );
  });
});

describe('Ask me each time', () => {
  it('shows the full command and folder with Approve and Reject', async () => {
    const { chat, workspace, agent } = await fixture();
    chat.commandApprovals = [
      { id: 'c1', command: 'del /q C:/x/*.tmp', cwd: 'C:/work' },
    ];
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('Commands waiting for you');
    expect(html).toContain('del /q C:/x/*.tmp');
    expect(html).toContain('Folder: C:/work');
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Reject<');
  });
  it.each([
    ['opencode', false],
    ['hermes', false],
    ['claude-code', true],
    ['codex', true],
  ] as const)(
    'offers Ask in Setup for %s: unavailable %s',
    async (runtime, unavailable) => {
      const { workspace, agent } = await fixture();
      agent.runtime = runtime;
      const html = renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
      expect(html).toContain('Ask me each time: approve every command');
      expect(/<option value="ask"[^>]*disabled/.test(html)).toBe(unavailable);
      expect(
        html.includes('Ask me each time is not available for this tool'),
      ).toBe(unavailable);
    },
  );
});

describe('Microsoft 365', () => {
  const render = (workspace: WorkspaceActions) =>
    renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
  it('is off and unavailable with a visible reason until an account is connected', async () => {
    const { workspace, agent } = await fixture();
    agent.runtime = 'claude-code';
    const html = render(workspace);
    expect(html).toMatch(/aria-label="Can use Microsoft 365"[^>]*disabled/);
    expect(html).toMatch(/class="agenthq-warning">Connect Microsoft 365 first/);
  });
  it('is offered once connected, with its warning when on, for Claude Code, OpenCode and Hermes but never Codex', async () => {
    const { workspace, agent } = await fixture();
    Object.assign(workspace.getSnapshot(), {
      m365: { connected: true, account: 'Me (me@example.com)' },
    });
    for (const runtime of ['claude-code', 'opencode', 'hermes']) {
      agent.runtime = runtime;
      agent.canUseM365 = false;
      expect(render(workspace)).not.toMatch(
        /aria-label="Can use Microsoft 365"[^>]*disabled/,
      );
    }
    agent.runtime = 'opencode';
    agent.canUseM365 = true;
    expect(render(workspace)).toContain('Their text is untrusted');
    agent.runtime = 'codex';
    agent.canUseM365 = false;
    const html = render(workspace);
    expect(html).toMatch(/aria-label="Can use Microsoft 365"[^>]*disabled/);
    expect(html).toContain('folder that keeps the Microsoft sign-in');
  });
  it('warns against pairing it with Allow freely commands', async () => {
    const { workspace, agent } = await fixture();
    Object.assign(workspace.getSnapshot(), { m365: { connected: true } });
    agent.runtime = 'opencode';
    agent.canUseM365 = true;
    agent.runCommands = 'allow';
    expect(render(workspace)).toContain('read the run’s sign-in file');
  });
  it('shows an action card with its title and the full text', async () => {
    const { chat, workspace, agent } = await fixture();
    chat.commandApprovals = [
      {
        id: 'c1',
        title: 'Send an email',
        command: 'To: boss@example.com / See attached',
      },
    ];
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('Send an email');
    expect(html).toContain('boss@example.com');
    expect(html).not.toContain('Folder:');
    expect(html).toContain('>Approve<');
  });
});

describe('Reply footer', () => {
  it('shows tokens for a Codex reply and dollars for others, never both', async () => {
    const { chat, workspace, agent } = await fixture();
    const entry = (extra: object) => ({
      role: 'assistant' as const,
      content: 'x',
      timestamp: '2026-10-21T08:00:00Z',
      tools: [],
      ...extra,
    });
    chat.messages = [entry({ tokens: 12345 }), entry({ costUsd: 0.0123 })];
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('12,345 tokens');
    expect(html).toContain('$0.0123');
  });
});

describe('Note types in Setup', () => {
  it('lists the types that are on with their folders, ticked as the agent has them, and nothing without Settings types', async () => {
    const { workspace, agent } = await fixture();
    const render = () =>
      renderToStaticMarkup(
        createElement(AgentPanelContent, { app: {} as App, workspace }),
      );
    expect(render()).not.toContain('Note types this agent may write');
    Object.assign(workspace.getSnapshot(), {
      noteTypes: [
        {
          id: 'meeting',
          label: 'Meeting notes',
          folder: 'Meetings',
          enabled: true,
        },
        { id: 'wiki', label: 'Wiki', folder: 'Wiki', enabled: false },
      ],
    });
    agent.noteTypes = ['meeting'];
    const html = render();
    expect(html).toContain('Note types this agent may write');
    expect(html).toMatch(/aria-label="Write Meeting notes"[^>]*checked/);
    expect(html).toContain('<code>Meetings/</code>');
    expect(html).not.toContain('Write Wiki');
    agent.noteTypes = [];
    expect(render()).not.toMatch(
      /aria-label="Write Meeting notes"[^>]*checked/,
    );
  });
});

describe('Chat composer and gear menu', () => {
  it('keeps Send and Stop with the gear last, and no New conversation button, when Enter does not send', async () => {
    const { chat, workspace, agent } = await fixture();
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('>Send<');
    expect(html.indexOf('>Send<')).toBeLessThan(html.indexOf('>Stop<'));
    expect(html.indexOf('>Stop<')).toBeLessThan(
      html.indexOf('More chat actions'),
    );
    expect(html).not.toContain('>New conversation<');
  });

  it('hides the Send button while Enter sends', async () => {
    const { chat, workspace, agent } = await fixture();
    const sending = {
      ...workspace,
      getSnapshot: () => ({ ...workspace.getSnapshot(), enterToSend: true }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace: sending,
        chat,
        id: agent.id,
      }),
    );
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
    expect(html).toContain('More chat actions');
  });
});

describe('History and navigation', () => {
  it('shows a Chat link on the Setup, Tasks and History tabs', async () => {
    const { workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).toContain('← Chat');
  });

  it('lists each conversation with a checkbox and keeps the destructive delete-all at the bottom', async () => {
    const { chat, workspace, agent } = await fixture();
    const withHistory = {
      ...chat,
      history: [
        { path: 'Mesa/Chats/x.md', name: 'x', frontmatter: {}, body: '' },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(HistoryContent, {
        workspace,
        id: agent.id,
        chats: [withHistory],
        scope: 'agent',
      }),
    );
    expect(html).toContain('aria-label="Select x"');
    expect(html).toContain('Delete all history for this agent');
    expect(html).not.toContain('Delete selected');
    expect(html).toContain('>Continue<');
    expect(html).toContain('>Rename<');
  });

  it('shows every session with its agent when the scope is All sessions', async () => {
    const { chat, workspace, agent } = await fixture();
    const withHistory = {
      ...chat,
      history: [
        { path: 'Mesa/Chats/x.md', name: 'x', frontmatter: {}, body: '' },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(HistoryContent, {
        workspace,
        id: agent.id,
        chats: [withHistory],
        scope: 'all',
      }),
    );
    expect(html).toContain('Coder · ');
    expect(html).toContain('Delete all chat notes');
  });

  it('turns the header select into scopes only while History is open', async () => {
    const { workspace } = await fixture();
    const inHistory = {
      ...workspace,
      getSnapshot: () => ({ ...workspace.getSnapshot(), agentTab: 'history' }),
    } as unknown as WorkspaceActions;
    const historyHtml = renderToStaticMarkup(
      createElement(AgentPanelContent, {
        app: {} as App,
        workspace: inHistory,
      }),
    );
    expect(historyHtml).toContain('aria-label="History scope"');
    expect(historyHtml).toContain('All sessions');
    const chatHtml = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(chatHtml).toContain('aria-label="Agent"');
    expect(chatHtml).not.toContain('All sessions');
  });

  it('does not show the jump button until the reader has scrolled away', async () => {
    const { chat, workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat,
        id: chat.agent.id,
      }),
    );
    expect(html).not.toContain('aria-label="Jump to latest"');
  });

  it('keeps Pin out of the header; the side panel offers Close and Full screen', async () => {
    const { workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, {
        app: {} as App,
        workspace,
        location: 'side',
        onMove: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).not.toContain('aria-label="Pin agent"');
    expect(html).not.toContain('>Hide<');
    expect(html).toContain('>Close<');
    expect(html).toContain('>Full screen<');
  });

  it('shows Side panel, not Full screen, for an agent in a main-area tab', async () => {
    const { workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, {
        app: {} as App,
        workspace,
        location: 'main',
        onMove: () => undefined,
      }),
    );
    expect(html).toContain('>Side panel<');
    expect(html).not.toContain('>Full screen<');
    expect(html).not.toContain('>Close<');
  });

  it('renders an approval card with every field and the full instructions as plain text', async () => {
    const { chat, workspace, agent } = await fixture();
    const reply =
      '```agenthq-admin\n{"actions":[{"type":"createAgent","name":"Researcher","role":"Analyst","instructions":"Use <b>bold</b> & quotes."}]}\n```';
    const proposals = parseObiProposals(reply, {
      agents: [agent],
      groups: [],
    }).proposals;
    const withCards = { ...chat, proposals };
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace,
        chat: withCards,
        id: agent.id,
      }),
    );
    expect(html).toContain('Create agent “Researcher”');
    expect(html).toContain('<dt>Permission</dt>');
    expect(html).toContain('Vault access');
    expect(html).toContain('<summary>Instructions</summary>');
    expect(html).toContain('Use &lt;b&gt;bold&lt;/b&gt; &amp; quotes.');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Reject<');
  });

  it('shows the Obi label for the built-in assistant in the header and dropdown', async () => {
    const { workspace, agent } = await fixture();
    const obi = { ...agent, id: OBI_ID, name: 'Obi' };
    const snapshot = workspace.getSnapshot();
    const withObi = {
      ...workspace,
      getSnapshot: () => ({
        ...snapshot,
        agents: [...snapshot.agents, obi],
        selectedId: OBI_ID,
      }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace: withObi }),
    );
    expect(html).toContain('<h2>Obi</h2>');
    expect(html).toContain('Obi');
  });

  it('keeps Open in new window out of the header; the gear menu keeps it', async () => {
    const { workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(AgentPanelContent, { app: {} as App, workspace }),
    );
    expect(html).not.toContain('Open in new window');
  });
});

describe('project picker in Chat', () => {
  it('lists only the projects the agent is assigned to, with No project first', async () => {
    const { chat, workspace, agent } = await fixture();
    const base = {
      agenthq: 'project',
      status: 'active',
      goal: '',
      teams: [],
      skills: [],
      archived: false,
      instructions: '',
      path: 'p',
      deadline: undefined,
      costLimitUsd: undefined,
    };
    const mine = { ...base, id: 'mine', name: 'Mine', agents: [agent.id] };
    const theirs = {
      ...base,
      id: 'theirs',
      name: 'Theirs',
      agents: ['someone-else'],
    };
    const withProjects = {
      ...workspace,
      getSnapshot: () => ({
        ...workspace.getSnapshot(),
        projects: [mine, theirs],
      }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace: withProjects,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('aria-label="Project"');
    expect(html).toContain('agenthq-project-picker');
    expect(html).not.toContain('>Theirs<');
  });
});

describe('repeat loop button in Chat', () => {
  it('shows the 🔁 button before the gear and the round while a loop runs', async () => {
    const { chat, workspace, agent } = await fixture();
    const looping = {
      ...workspace,
      getSnapshot: () => ({
        ...workspace.getSnapshot(),
        chat: {
          ...workspace.getSnapshot().chat!,
          loops: { [agent.id]: { round: 2, rounds: 5 } },
        },
      }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(ChatContent, {
        app: {} as App,
        workspace: looping,
        chat,
        id: agent.id,
      }),
    );
    expect(html).toContain('aria-label="Repeat"');
    expect(html).toContain('Round 2/5');
    expect(html.indexOf('aria-label="Repeat"')).toBeLessThan(
      html.indexOf('aria-label="More chat actions"'),
    );
  });
});
