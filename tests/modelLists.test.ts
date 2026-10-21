import { describe, expect, it } from 'vitest';
import { parseCodexModels, parseOpenCodeModels } from '../src/core/models';

describe('runtime model listings', () => {
  it('reads OpenCode provider/model lines and labels free models', () => {
    const list = parseOpenCodeModels(
      'opencode/nemotron-3.5-lightning-free\nopenrouter/google/gemini-2.5-flash\n\nnot a model line\n',
    );
    expect(list).toEqual([
      {
        value: 'opencode/nemotron-3.5-lightning-free',
        label: 'opencode/nemotron-3.5-lightning-free (free)',
      },
      {
        value: 'openrouter/google/gemini-2.5-flash',
        label: 'openrouter/google/gemini-2.5-flash',
      },
    ]);
  });

  it('reads only Codex catalog models that are listed for users', () => {
    const json = JSON.stringify({
      models: [
        { slug: 'gpt-x', display_name: 'GPT X', visibility: 'list' },
        { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        { display_name: 'No slug', visibility: 'list' },
      ],
    });
    expect(parseCodexModels(json)).toEqual([
      { value: 'gpt-x', label: 'GPT X (gpt-x)' },
    ]);
    expect(parseCodexModels('not json')).toEqual([]);
  });
});
