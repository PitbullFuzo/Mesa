import { describe, expect, it } from 'vitest';
import {
  modelChoices,
  modelSelectOptions,
  OTHER_MODEL,
} from '../src/core/models';

describe('model choices', () => {
  it('offers the Claude Code aliases, with Default first', () => {
    const values = modelChoices('claude-code').map((choice) => choice.value);
    expect(values).toEqual(['', 'haiku', 'sonnet', 'opus']);
  });

  it('offers only Default for runtimes without a verified list', () => {
    expect(modelChoices('codex').map((choice) => choice.value)).toEqual(['']);
    expect(modelChoices('hermes').map((choice) => choice.value)).toEqual(['']);
  });

  it('always offers Other, last', () => {
    const options = modelSelectOptions('claude-code', 'haiku');
    expect(options.at(-1)!.value).toBe(OTHER_MODEL);
    expect(modelSelectOptions('codex', '').at(-1)!.value).toBe(OTHER_MODEL);
  });

  it('keeps a saved value that is not in the list as a Custom entry', () => {
    const options = modelSelectOptions('claude-code', 'my-model');
    expect(options).toContainEqual({
      value: 'my-model',
      label: 'Custom: my-model',
    });
  });

  it('does not duplicate a saved value that is already listed', () => {
    const options = modelSelectOptions('claude-code', 'opus');
    expect(options.filter((choice) => choice.value === 'opus')).toHaveLength(1);
    expect(options.some((choice) => choice.label.startsWith('Custom'))).toBe(
      false,
    );
  });
});

describe('loaded runtime lists', () => {
  it('adds a loaded list after Default and keeps Other last', () => {
    const options = modelSelectOptions('codex', '', [
      { value: 'gpt-x', label: 'GPT X (gpt-x)' },
    ]);
    expect(options.map((choice) => choice.value)).toEqual([
      '',
      'gpt-x',
      OTHER_MODEL,
    ]);
  });
});
