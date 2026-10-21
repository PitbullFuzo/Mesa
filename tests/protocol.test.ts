import { describe, expect, it } from 'vitest';
import { parseDelegation } from '../src/core/protocol';
import { buildSystemPrompt } from '../src/core/prompt';
import type { Agent } from '../src/core/model';

const agent = {
  id: 'lead',
  instructions: 'Lead carefully.',
  skills: ['skill'],
} as Agent;
describe('delegation protocol', () => {
  it('parses a single terminal block with schema defaults and rejects malformed or multiple blocks', () => {
    const block =
      '```agenthq-delegate\n{"tasks":[{"to":"Coder","task":"Build"}]}\n```';
    expect(parseDelegation('Plan\n' + block)).toEqual({
      kind: 'valid',
      tasks: [{ to: 'Coder', task: 'Build' }],
    });
    expect(parseDelegation('Normal reply')).toEqual({ kind: 'none' });
    for (const text of [
      block + '\nMore',
      block + '\n' + block,
      '```agenthq-delegate\n{}\n```',
      '```agenthq-delegate\n{"tasks":[]}\n```',
      '```agenthq-delegate\n{"tasks":[{"to":"","task":""}]}\n```',
      '```agenthq-delegate\nnot json',
      '```agenthq-delegate\n{"tasks":[{"to":"Coder","task":"Build","maxAttempts":0}]}\n```',
    ]) {
      expect(parseDelegation(text).kind).toBe('invalid');
    }
  });
  it('lists only direct reports, their role and first instruction line alongside linked skills', () => {
    const prompt = buildSystemPrompt(
      agent,
      [
        {
          ...agent,
          id: 'worker',
          name: 'Coder',
          role: 'Engineer',
          reportsTo: 'lead',
          instructions: 'First line\nPrivate detail',
        },
        { ...agent, id: 'other', name: 'Other', reportsTo: null },
      ],
      [{ path: 'skill', name: 'Quality', body: 'Test first' }],
    );
    expect(prompt).toContain('Coder');
    expect(prompt).toContain('Engineer');
    expect(prompt).toContain('First line');
    expect(prompt).not.toContain('Private detail');
    expect(prompt).not.toContain('Other');
    expect(prompt).toContain('agenthq-delegate');
    expect(prompt).toContain('## Skill: Quality\nTest first');
  });
});
