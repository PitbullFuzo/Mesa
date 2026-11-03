import { describe, expect, it } from 'vitest';
import { isBrowserVerifiedVersion } from '../src/core/runtimes/claudeCode';

describe('Claude Code browser version check', () => {
  it('allows the verified version and anything newer', () => {
    for (const v of [
      '2.1.286 (Claude Code)',
      '2.1.317 (Claude Code)',
      '2.2.0 (Claude Code)',
      '3.0.0 (Claude Code)',
      '2.1.1000',
      '  2.1.290 (Claude Code)\n',
    ])
      expect(isBrowserVerifiedVersion(v), v).toBe(true);
  });

  it('refuses older or unreadable versions', () => {
    for (const v of [
      '2.1.285 (Claude Code)',
      '2.0.999 (Claude Code)',
      '1.9.0 (Claude Code)',
      'old',
      '',
      'Claude Code 2.1.300',
    ])
      expect(isBrowserVerifiedVersion(v), v).toBe(false);
  });
});
