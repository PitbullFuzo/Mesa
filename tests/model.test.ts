import { describe, expect, it } from 'vitest';
import {
  agentFrontmatterSchema,
  chatMessageSchema,
  taskSchema,
} from '../src/core/model';
import { DEFAULT_RUNTIME_ID } from '../src/core/runtimes/ids';

export const frontmatter = (id = 'coder') => ({
  agenthq: 'agent',
  id,
  role: 'Software engineer',
  reportsTo: '[[CEO]]',
  group: 'core',
  runtime: DEFAULT_RUNTIME_ID,
  model: null,
  permission: 'edit',
  workdir: null,
  verifier: '[[Reviewer]]',
  skills: ['[[karpathy-guidelines]]'],
});

describe('note schemas', () => {
  it('uses the shared runtime default for an empty runtime string', () => {
    expect(
      agentFrontmatterSchema.parse({ ...frontmatter(), runtime: '' }).runtime,
    ).toBe(DEFAULT_RUNTIME_ID);
  });
  it('validates agent metadata and normalizes empty optional fields', () => {
    const parsed = agentFrontmatterSchema.parse({
      ...frontmatter(),
      reportsTo: '',
      verifier: '',
      group: '',
      model: null,
      workdir: null,
    });
    expect(parsed).toMatchObject({
      reportsTo: null,
      verifier: null,
      group: null,
      model: '',
      workdir: '',
    });
    expect(agentFrontmatterSchema.safeParse(frontmatter()).success).toBe(true);
    for (const patch of [
      { id: '' },
      { id: 'Bad ID' },
      { permission: 'unsafe' },
      { reportsTo: 'CEO' },
      { verifier: 'Reviewer' },
      { skills: [42] },
      { agenthq: 'chat' },
    ]) {
      expect(
        agentFrontmatterSchema.safeParse({ ...frontmatter(), ...patch })
          .success,
      ).toBe(false);
    }
  });
  it('validates minimal task and chat message records without orchestration', () => {
    expect(
      taskSchema.safeParse({
        agenthq: 'task',
        from: '[[CEO]]',
        to: '[[Coder]]',
        verifier: null,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        requestId: 'req-1',
        depth: 0,
        sessionId: 'session-1',
      }).success,
    ).toBe(true);
    expect(taskSchema.safeParse({ status: 'surprise' }).success).toBe(false);
    expect(
      chatMessageSchema.safeParse({
        role: 'user',
        content: 'Hello',
        timestamp: '2026-10-14T10:42:00Z',
      }).success,
    ).toBe(true);
    expect(
      chatMessageSchema.safeParse({
        role: 'other',
        content: 'Hello',
        timestamp: '',
      }).success,
    ).toBe(false);
  });
});
