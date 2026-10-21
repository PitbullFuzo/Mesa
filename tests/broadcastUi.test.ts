import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BroadcastBar } from '../src/obsidian/views/broadcastBar';
import { MemoryStore } from '../src/core/memoryStore';
import { initializeStarterTeam } from '../src/core/starter';
import type {
  WorkspaceActions,
  WorkspaceSnapshot,
} from '../src/core/workspace';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));

async function fixture() {
  const store = new MemoryStore();
  await initializeStarterTeam(store, 'Obi-I');
  const state: WorkspaceSnapshot = {
    ...(await store.loadAgents()),
    groups: await store.loadGroups(),
    skills: [],
    layout: {},
    selectedId: null,
    selectionRevision: 0,
    agentTab: 'chat',
    enterToSend: false,
    loading: false,
    error: null,
    chat: { agents: {}, runtimes: {}, queue: { running: 0, queued: 0 } },
  };
  const workspace = {
    getSnapshot: () => state,
    subscribe: () => () => undefined,
  } as unknown as WorkspaceActions;
  return { state, workspace };
}

describe('Broadcast bar', () => {
  it('offers Everyone, the team groups and individual agents, with an accessible composer', async () => {
    const { workspace } = await fixture();
    const html = renderToStaticMarkup(
      createElement(BroadcastBar, { workspace }),
    );
    expect(html).toContain('aria-label="Broadcast target"');
    expect(html).toContain('value="everyone"');
    expect(html).toContain('value="group:core"');
    expect(html).toContain('Core team');
    expect(html).toContain('value="agent:coder"');
    expect(html).toContain('aria-label="Broadcast message"');
    expect(html).toContain('Broadcast');
  });
  it('shows replied and skipped recipients with reasons and disables sending while running', async () => {
    const { state, workspace } = await fixture();
    state.chat!.broadcast = {
      target: { kind: 'everyone' },
      text: 'hello',
      running: true,
      recipients: [
        { key: 'coder', agentId: 'coder', name: 'Coder', status: 'replied' },
        {
          key: 'offline',
          name: 'Offline agent',
          status: 'skipped',
          reason: 'Runtime unavailable',
        },
        {
          key: 'broken',
          name: 'Broken agent',
          status: 'skipped',
          reason: 'Invalid permission',
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(BroadcastBar, { workspace }),
    );
    expect(html).toContain('Replied');
    expect(html).toContain('Skipped');
    expect(html).toContain('Runtime unavailable');
    expect(html).toContain('Invalid permission');
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain('Sending…');
  });

  it('hides the Broadcast button while Enter sends', async () => {
    const { state, workspace } = await fixture();
    const sending = {
      ...workspace,
      getSnapshot: () => ({ ...state, enterToSend: true }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(BroadcastBar, { workspace: sending }),
    );
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
  });
});
