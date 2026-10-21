import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseVersion,
  versionVerdict,
} from '../src/core/runtimes/versionPolicy';

describe('version policy', () => {
  it('reads the first x.y.z from a version line', () => {
    expect(parseVersion('codex-cli 0.163.0')).toBe('0.163.0');
    expect(parseVersion('1.19.1')).toBe('1.19.1');
    expect(parseVersion('no version here')).toBeUndefined();
  });

  it('compares part by part, so 0.163.0 is newer than 0.160.0 and 0.9.0 older than 0.10.0', () => {
    expect(compareVersions('0.163.0', '0.160.0')).toBeGreaterThan(0);
    expect(compareVersions('0.159.9', '0.160.0')).toBeLessThan(0);
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.19.1', '1.19.1')).toBe(0);
  });

  it('classifies a version as verified, newer, older or unknown', () => {
    expect(versionVerdict('codex-cli 0.160.0', '0.160.0')).toBe('verified');
    expect(versionVerdict('codex-cli 0.163.0', '0.160.0')).toBe('newer');
    expect(versionVerdict('codex-cli 0.150.0', '0.160.0')).toBe('older');
    expect(versionVerdict('', '0.160.0')).toBe('unknown');
  });
});
