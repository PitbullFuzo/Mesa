import { describe, expect, it } from 'vitest';
import { openCodeModelsCommand } from '../src/core/runtimes/modelLists';

describe('OpenCode model list command', () => {
  it('runs exactly the models subcommand, not the ACP server', () => {
    expect(openCodeModelsCommand('C:/tools/opencode.exe')).toEqual({
      file: 'C:/tools/opencode.exe',
      args: ['models'],
    });
  });
});
