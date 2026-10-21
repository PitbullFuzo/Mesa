import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TasksContent } from '../src/obsidian/views/tasksContent';
import type { WorkspaceActions } from '../src/core/workspace';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
}));

function render(tasks: unknown[] = []) {
  const workspace = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ tasks }),
  } as unknown as WorkspaceActions;
  return renderToStaticMarkup(
    createElement(TasksContent, { workspace, id: 'coder' }),
  );
}

describe('Tasks panel', () => {
  it('lists only the selected worker tasks with status, attempt and verdict', () => {
    const html = render([
      {
        path: 'Mesa/Tasks/Hello.md',
        name: 'Hello',
        frontmatter: {
          agenthq: 'task',
          toId: 'coder',
          status: 'passed',
          attempt: 1,
          maxAttempts: 3,
        },
        body: 'hi',
      },
      {
        path: 'Mesa/Tasks/Other.md',
        name: 'Other',
        frontmatter: {
          agenthq: 'task',
          toId: 'reviewer',
          status: 'failed',
          attempt: 1,
          maxAttempts: 3,
        },
        body: '',
      },
    ]);
    expect(html).toContain('Hello');
    expect(html).toContain('passed');
    expect(html).toContain('Attempt 1 / 3');
    expect(html).toContain('No verification');
    expect(html).not.toContain('Other');
    expect(html).toContain('<button');
  });
  it('shows an empty state and isolates malformed task metadata', () => {
    expect(render()).toContain('No tasks for this agent yet.');
    expect(
      render([{ path: 'bad', name: 'Bad', frontmatter: null, body: '' }]),
    ).toContain('No tasks for this agent yet.');
  });
});
