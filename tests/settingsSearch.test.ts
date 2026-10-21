import { describe, expect, it, vi } from 'vitest';
import { loadSettings } from '../src/core/settings';

const created: string[] = [];

vi.mock('obsidian', () => {
  /** A Setting that accepts any chained call and remembers the names it was given. */
  class Setting {
    constructor() {
      const self: object = new Proxy(this, {
        get: (_target, key) => {
          if (key === 'setName')
            return (name: string) => {
              created.push(name);
              return self;
            };
          if (key === 'settingEl')
            return { after: () => undefined, hide: () => undefined };
          return () => self;
        },
      });
      return self;
    }
  }
  class PluginSettingTab {
    containerEl = { empty: () => undefined };
    constructor(
      public app: unknown,
      public plugin: unknown,
    ) {}
  }
  return {
    FuzzySuggestModal: class {},
    Menu: class {},
    Notice: class {},
    Modal: class {},
    Setting,
    PluginSettingTab,
    TextComponent: class {},
  };
});

const { AgentHQSettingTab } = await import('../src/obsidian/settings');

function tab() {
  const plugin = {
    settings: loadSettings(null),
    graphAiTotal: 0,
    graphAiStatus: '',
    workspace: {
      getSnapshot: () => ({ browser: undefined, m365: undefined }),
    },
  };
  const app = {
    vault: {
      configDir: '.obsidian',
      getConfig: () => [],
      getFolderByPath: () => null,
      getAbstractFileByPath: () => null,
    },
  };
  return new AgentHQSettingTab(app as never, plugin as never);
}

describe('settings page', () => {
  it('display() builds every main row', () => {
    created.length = 0;
    tab().display();
    for (const wanted of [
      'Mesa folder',
      'Folders agents may touch',
      'Browser engine',
      'Note destinations',
      'Press Enter to send',
      'Runtime path override',
      'Microsoft 365',
    ])
      expect(created).toContain(wanted);
  });

  it('does not offer settings definitions (they rendered without controls on Obsidian 1.14)', () => {
    expect('getSettingDefinitions' in tab()).toBe(false);
  });
});
