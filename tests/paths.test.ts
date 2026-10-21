import { describe, expect, it } from 'vitest';
import { managedPath, vaultRoot } from '../src/core/paths';

describe('managed vault paths', () => {
  it('accepts vault-relative nested folders', () => {
    expect(vaultRoot('Teams\\Mesa/', '.obsidian')).toBe('Teams/Mesa');
    expect(managedPath('Teams/Mesa', 'Teams/Mesa/Agents/CEO.md')).toBe(
      'Teams/Mesa/Agents/CEO.md',
    );
  });

  it.each([
    '',
    '/',
    '.',
    '..',
    '../Notes',
    'Mesa/../Notes',
    'C:/Notes',
    '\\\\server\\share',
    '.obsidian',
    '.obsidian/Agents',
    '.Obsidian/Agents',
  ])('refuses unsafe roots: %s', (path) => {
    expect(() => vaultRoot(path, '.obsidian')).toThrow();
  });

  it('respects a custom configuration directory', () => {
    expect(() => vaultRoot('Config/Agents', 'Config')).toThrow();
  });

  it.each([
    'Notes/CEO.md',
    'Mesa-other/CEO.md',
    'Mesa/../Notes/CEO.md',
    '/Mesa/CEO.md',
  ])('refuses writes outside the managed root: %s', (path) => {
    expect(() => managedPath('Mesa', path)).toThrow();
  });
});
