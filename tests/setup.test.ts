import { describe, expect, it } from 'vitest';
import { agentPatchToFrontmatter, setupPatchSchema } from '../src/core/setup';
import {
  DEFAULT_RUNTIME_ID,
  RUNTIME_OPTIONS,
  staticRuntimeStatus,
} from '../src/core/runtimes/ids';

describe('Setup patch boundary', () => {
  it('maps every frontmatter field and leaves note name/body out', () => {
    const patch = setupPatchSchema.parse({
      name: 'Engineer',
      role: '',
      runtime: 'future',
      model: '',
      permission: 'full',
      workdir: '',
      verifier: 'reviewer',
      group: null,
      skills: ['Team/Skills/rules.md'],
      instructions: '',
    });
    expect(
      agentPatchToFrontmatter(
        patch,
        (id) => `[[agent:${id}]]`,
        (path) => `[[skill:${path}]]`,
      ),
    ).toEqual({
      role: '',
      runtime: 'future',
      model: '',
      permission: 'full',
      workdir: '',
      verifier: '[[agent:reviewer]]',
      group: null,
      skills: ['[[skill:Team/Skills/rules.md]]'],
    });
    expect(
      agentPatchToFrontmatter(
        { role: 'Only role' },
        () => {
          throw new Error('Unrelated agent lookup');
        },
        () => {
          throw new Error('Unrelated skill lookup');
        },
      ),
    ).toEqual({ role: 'Only role' });
    expect(
      agentPatchToFrontmatter(
        { verifier: null, skills: [], group: '' },
        () => '',
        () => '',
      ),
    ).toEqual({ verifier: null, skills: [], group: '' });
  });
  it('accepts only editable fields and safe nonblank note basenames', () => {
    expect(setupPatchSchema.parse({})).toEqual({});
    for (const name of [
      '',
      '  ',
      '.',
      '..',
      '../escape',
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a\n',
      'CON',
      'nul.txt',
      'trailing.',
      'trailing ',
    ])
      expect(setupPatchSchema.safeParse({ name }).success, name).toBe(false);
    expect(setupPatchSchema.safeParse({ name: 'Team lead' }).success).toBe(
      true,
    );
    for (const patch of [
      { reportsTo: 'lead' },
      { id: 'changed' },
      { permission: 'unsafe' },
      { verifier: '' },
      { skills: [2] },
    ])
      expect(setupPatchSchema.safeParse(patch).success).toBe(false);
  });
  it('exposes static registered runtime status without detection', () => {
    expect(RUNTIME_OPTIONS.map((option) => option.id)).toEqual([
      DEFAULT_RUNTIME_ID,
      'hermes',
      'opencode',
      'codex',
    ]);
    expect(RUNTIME_OPTIONS[0].label.length).toBeGreaterThan(0);
    expect(staticRuntimeStatus(DEFAULT_RUNTIME_ID)).toBe('idle');
    expect(staticRuntimeStatus('unknown')).toBe('offline');
  });
});
