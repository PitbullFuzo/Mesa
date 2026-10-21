import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceActions } from '../src/core/workspace';
import { InboxContent } from '../src/obsidian/views/inboxContent';
import { StopAllButton } from '../src/obsidian/views/stopAllButton';
import { TeamPanelContent } from '../src/obsidian/views/panelContent';

vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
}));

vi.mock('../src/obsidian/views/markdownContent', () => ({
  MarkdownContent: () => null,
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));

function workspace(inbox: unknown[] = []) {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => ({
      agents: [{ id: 'coder', name: 'Coder' }],
      chat: { inbox, queue: { running: 0, queued: 0 } },
    }),
  } as unknown as WorkspaceActions;
}

describe('Inbox and Stop all controls', () => {
  it('mounts the existing inbox in the actual Team panel', () => {
    const team = {
      subscribe: () => () => undefined,
      getSnapshot: () => ({
        agents: [],
        groups: [],
        invalidAgents: [],
        loading: false,
        error: null,
        chat: { inbox: [] },
      }),
    } as unknown as WorkspaceActions;
    const html = renderToStaticMarkup(
      createElement(TeamPanelContent, { workspace: team }),
    );
    expect(html).toContain('Inbox (0)');
  });

  it('counts unresolved records from the existing inbox and offers task-resolution buttons', () => {
    const html = renderToStaticMarkup(
      createElement(InboxContent, {
        workspace: workspace([
          {
            id: 'active',
            agentId: 'coder',
            kind: 'verification-exhausted',
            message: 'Review failed',
            path: 'Obi-I/Tasks/task.md',
          },
          {
            id: 'done',
            agentId: 'coder',
            kind: 'verification-exhausted',
            message: 'Already resolved',
            resolved: true,
          },
        ]),
      }),
    );
    expect(html).toContain('Inbox (1)');
    expect(html).toContain('Coder');
    expect(html).toContain('Review failed');
    expect(html).not.toContain('Already resolved');
    expect(html).toContain('Accept anyway');
    expect(html).toContain('Retry 2 more');
    expect(html).toContain('Cancel task');
    expect(html).toContain('Open note');
  });
  it('shows actionable non-task items without offering unsafe task controls', () => {
    const html = renderToStaticMarkup(
      createElement(InboxContent, {
        workspace: workspace([
          {
            id: 'auth',
            agentId: 'coder',
            kind: 'runtime-auth',
            message: '<script>Sign in</script>',
            path: 'Obi-I/Chats/chat.md',
          },
        ]),
      }),
    );
    expect(html).toContain('Dismiss');
    expect(html).toContain('Open note');
    expect(html).not.toContain('Accept anyway');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('shows an empty inbox and leaves Stop all usable between queued turns', () => {
    const html = renderToStaticMarkup(
      createElement(InboxContent, { workspace: workspace() }),
    );
    expect(html).toContain('Inbox (0)');
    expect(html).toContain('No items need your attention.');
    const stop = renderToStaticMarkup(
      createElement(StopAllButton, { workspace: workspace() }),
    );
    expect(stop).toContain('Stop all');
    expect(stop).not.toContain('disabled');
  });
});
