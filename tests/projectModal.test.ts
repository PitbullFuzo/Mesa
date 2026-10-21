import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { Project } from '../src/core/projects';
import type { WorkspaceActions } from '../src/core/workspace';
import { openProjectForm } from '../src/obsidian/projectModal';

// Obsidian's Setting is a builder with a `then` method. A Setting returned from a promise callback is therefore
// a thenable: the promise keeps resolving with it, forever. The mock counts `then` calls and stops the loop at 100.
const thenCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('obsidian', () => {
  const builder = (): unknown => {
    const self: unknown = new Proxy(function () {}, {
      get: (_target, property) => {
        if (property === 'then')
          return (onFulfilled: (value: unknown) => void) => {
            thenCalls.count++;
            if (thenCalls.count > 100) throw new Error('Setting.then loop');
            onFulfilled(self);
            return self;
          };
        if (
          property === 'inputEl' ||
          property === 'selectEl' ||
          property === 'controlEl'
        )
          return { rows: 0, options: [], empty: () => {}, addClass: () => {} };
        return () => self;
      },
      apply: () => self,
    });
    return self;
  };
  function Setting() {
    return builder();
  }
  class Modal {
    contentEl = builder();
    open(): void {
      (this as unknown as { onOpen(): void }).onOpen();
    }
    setTitle(): void {}
    close(): void {}
  }
  class FuzzySuggestModal {}
  class Notice {}
  return { Setting, Modal, FuzzySuggestModal, Notice };
});

describe('project form', () => {
  it('does not resolve a promise with a Setting when it shows the memory line', async () => {
    thenCalls.count = 0;
    const project = {
      id: 'p1',
      name: 'Sales',
      path: 'Obi-I/Projects/Sales.md',
      status: 'active',
      goal: '',
      teams: [],
      agents: [],
      skills: [],
      archived: false,
      instructions: '',
      contextLevels: {},
    } as unknown as Project;
    const projectMemoryInfo = vi.fn(async () => ({
      model: 'Off (log only)',
      notes: 0,
      lastContextWords: null,
    }));
    const workspace = {
      getSnapshot: () => ({ groups: [], agents: [], skills: [] }),
      projectMemoryInfo,
      reportError: vi.fn(),
    } as unknown as WorkspaceActions;

    openProjectForm({} as App, workspace, project);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(projectMemoryInfo).toHaveBeenCalledWith(project.path);
    expect(thenCalls.count).toBeLessThanOrEqual(1);
  });
});
