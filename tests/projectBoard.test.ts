import { describe, expect, it } from 'vitest';
import type { NoteDocument } from '../src/core/notes';
import type { Project } from '../src/core/projects';
import {
  BOARD_COLUMNS,
  logSummary,
  projectStats,
  taskColumnOf,
  taskFacts,
} from '../src/core/projectBoard';

const note = (
  name: string,
  frontmatter: Record<string, unknown>,
  body = '',
): NoteDocument => ({
  path: `Mesa/Tasks/${name}.md`,
  name,
  frontmatter,
  body,
});
const project = { id: 'p1', name: 'Shop', status: 'active' } as Project;
const log = (body: string): NoteDocument => ({
  path: 'Mesa/Projects/Shop/Log.md',
  name: 'Log',
  frontmatter: {},
  body,
});

describe('project board', () => {
  it('has the five board columns in order', () => {
    expect([...BOARD_COLUMNS]).toEqual([
      'planned',
      'active',
      'ongoing',
      'paused',
      'done',
    ]);
  });

  it('reads project, status and cost from a task note', () => {
    expect(
      taskFacts(
        note('Build it', {
          projectId: 'p1',
          status: 'passed',
          workerTotalCostUsd: 0.02,
          verifierTotalCostUsd: 0.01,
        }),
      ),
    ).toEqual({
      name: 'Build it',
      projectId: 'p1',
      status: 'passed',
      costUsd: 0.03,
    });
  });

  it('maps task statuses to the four task columns', () => {
    expect(taskColumnOf('queued')).toBe('todo');
    expect(taskColumnOf('running')).toBe('progress');
    expect(taskColumnOf('failed')).toBe('progress');
    expect(taskColumnOf('verifying')).toBe('review');
    expect(taskColumnOf('passed')).toBe('done');
    expect(taskColumnOf('unknown')).toBeNull();
  });

  it('takes memory spend and the last entry time from the Log', () => {
    const summary = logSummary(
      log(
        '# Log\n\n- 2026-10-18T10:00:00.000Z · [[A]] · Coder · passed\n' +
          '- 2026-10-18T11:00:00.000Z · memory: 1 saved, 0 merged · memory cost $0.0040\n',
      ),
    );
    expect(summary.lastActivity).toBe('2026-10-18T11:00:00.000Z');
    expect(summary.memoryCostUsd).toBeCloseTo(0.004);
    expect(summary.tail).toHaveLength(2);
    expect(logSummary(null)).toEqual({
      memoryCostUsd: 0,
      lastActivity: null,
      tail: [],
    });
  });

  it("computes counts, progress and cost from the project's own tasks and its Log", () => {
    const tasks = [
      taskFacts(
        note('a', {
          projectId: 'p1',
          status: 'passed',
          workerTotalCostUsd: 0.1,
        }),
      ),
      taskFacts(
        note('b', {
          projectId: 'p1',
          status: 'queued',
          workerTotalCostUsd: 0.05,
        }),
      ),
      taskFacts(
        note('c', {
          projectId: 'other',
          status: 'passed',
          workerTotalCostUsd: 9,
        }),
      ),
    ];
    const chats = [
      { projectId: 'p1', costUsd: 0.25 },
      { projectId: 'other', costUsd: 7 },
    ];
    const stats = projectStats(
      project,
      tasks,
      chats,
      logSummary(
        log(
          '- 2026-10-18T12:00:00.000Z · memory: 0 saved, 0 merged · memory cost $0.0100',
        ),
      ),
    );
    expect(stats.total).toBe(2);
    expect(stats.done).toBe(1);
    expect(stats.progress).toBe(0.5);
    expect(stats.costUsd).toBeCloseTo(0.41);
    expect(stats.lastActivity).toBe('2026-10-18T12:00:00.000Z');
  });

  it('shows zero progress and no activity for a project with no tasks or Log', () => {
    expect(projectStats(project, [], [], undefined)).toEqual({
      total: 0,
      done: 0,
      progress: 0,
      costUsd: 0,
      lastActivity: null,
    });
  });
});
