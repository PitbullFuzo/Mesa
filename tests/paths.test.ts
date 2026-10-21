import { describe, expect, it } from 'vitest';
import { managedPath, vaultRoot } from '../src/core/paths';

describe('managed vault paths', () => {
  it('accepts vault-relative nested folders', () => {
    expect(vaultRoot('Teams\\Obi-I/', '.obsidian')).toBe('Teams/Obi-I');
    expect(managedPath('Teams/Obi-I', 'Teams/Obi-I/Agents/CEO.md')).toBe(
      'Teams/Obi-I/Agents/CEO.md',
    );
  });

  it.each([
    '',
    '/',
    '.',
    '..',
    '../Notes',
    'Obi-I/../Notes',
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
    'Obi-I-other/CEO.md',
    'Obi-I/../Notes/CEO.md',
    '/Obi-I/CEO.md',
  ])('refuses writes outside the managed root: %s', (path) => {
    expect(() => managedPath('Obi-I', path)).toThrow();
  });
});
