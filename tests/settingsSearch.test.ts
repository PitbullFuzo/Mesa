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

describe('settings search (Obsidian 1.13 and later)', () => {
  it('lists the main settings, each with a name and a way to build its row', () => {
    const definitions = tab().getSettingDefinitions() as {
      name: string;
      aliases: string[];
      render: unknown;
    }[];
    const names = definitions.map((definition) => definition.name);
    for (const wanted of [
      'Mesa folder',
      'Folders agents may touch',
      'Browser engine',
      'Connectors',
      'Note destinations',
    ])
      expect(names).toContain(wanted);
    for (const definition of definitions)
      expect(typeof definition.render).toBe('function');
    expect(
      definitions.find((definition) => definition.name === 'Connectors')
        ?.aliases,
    ).toContain('microsoft');
  });

  it('keeps the page whole: display() builds every row the definitions list', () => {
    created.length = 0;
    const settings = tab();
    const definitions = settings.getSettingDefinitions();
    settings.display();
    expect(created).toContain('Mesa folder');
    expect(created).toContain('Press Enter to send');
    expect(created).toContain('Runtime path override');
    expect(created).toContain('Microsoft 365');
    expect(created.length).toBeGreaterThanOrEqual(definitions.length);
  });
});
