import { describe, expect, it } from 'vitest';
import { modelSelectOptions, runtimeModelLabel } from '../src/core/models';

const loaded = [
  { value: 'opencode/nemotron-free', label: 'opencode/nemotron-free (free)' },
];

describe('runtime and model label', () => {
  it('shows the runtime and the short model name', () => {
    expect(runtimeModelLabel('claude-code', 'haiku')).toBe(
      'Claude Code · Haiku',
    );
    expect(runtimeModelLabel('claude-code', 'opus')).toBe('Claude Code · Opus');
  });

  it('shows "default" when no model is set', () => {
    expect(runtimeModelLabel('claude-code', '')).toBe('Claude Code · default');
    expect(runtimeModelLabel('codex', '')).toBe('Codex · default');
  });

  it('uses the friendly label from the runtime list, and the raw name when it is not listed', () => {
    expect(
      runtimeModelLabel('opencode', 'opencode/nemotron-free', loaded),
    ).toBe('OpenCode · opencode/nemotron-free (free)');
    expect(runtimeModelLabel('opencode', 'unlisted/model', loaded)).toBe(
      'OpenCode · unlisted/model',
    );
  });

  it('keeps the menu options Setup offers, with Other last', () => {
    const options = modelSelectOptions('claude-code', 'haiku');
    expect(options.map((option) => option.value)).toEqual([
      '',
      'haiku',
      'sonnet',
      'opus',
      '__other__',
    ]);
  });
});
