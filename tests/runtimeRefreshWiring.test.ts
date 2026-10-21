import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import AgentHQPlugin from '../src/main';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  adapters: vi.fn(),
}));
// The plugin uses window timers; the node test environment has no window.
vi.mock('obsidian', () => ({
  ItemView: class {},
  Modal: class {},
  Setting: class {},
  Plugin: class {
    constructor(public app: App) {}
    loadData = async () => ({});
    saveData = async () => {};
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
    registerInterval() {}
    register() {}
  },
  FileSystemAdapter: class {
    getBasePath() {
      return '/vault';
    }
  },
}));
vi.mock('../src/obsidian/workspaceController', () => ({
  WorkspaceController: class {
    refresh = mocks.refresh;
    reportError = vi.fn();
    setEnterToSend = vi.fn();
    setAgentPlacement = vi.fn();
    setTourState = vi.fn();
    setAllowedFolders = vi.fn();
  },
}));
vi.mock('../src/core/runtimes/registry', () => ({
  createRuntimeAdapters: mocks.adapters,
}));
vi.mock('../src/obsidian/modals', () => ({ pickAgent: vi.fn() }));
vi.mock('../src/obsidian/projectModal', () => ({ pickProject: vi.fn() }));
vi.mock('../src/obsidian/menus', () => ({ registerNoteMenus: vi.fn() }));
vi.mock('../src/obsidian/settings', () => ({ AgentHQSettingTab: class {} }));
vi.mock('../src/obsidian/obsidianStore', () => ({ ObsidianStore: class {} }));
vi.mock('../src/obsidian/views/graphView', () => ({
  GraphView: class {},
  GRAPH_VIEW: 'graph',
}));
vi.mock('../src/obsidian/views/panels', () => ({
  AgentPanel: class {},
  ProjectsPanel: class {},
  TeamPanel: class {},
  AGENT_VIEW: 'agent',
  PROJECTS_VIEW: 'projects',
  SCHEDULES_VIEW: 'schedules',
  SchedulesPanel: class {},
  SKILLS_VIEW: 'skills',
  SkillsPanel: class {},
  TEAM_VIEW: 'team',
}));

beforeEach(() => {
  vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fixture() {
  const { FileSystemAdapter } = await import('obsidian');
  const handlers: Record<string, (file: { path: string }) => void> = {};
  const app = {
    vault: {
      adapter: new FileSystemAdapter(),
      configDir: '.obsidian',
      on: (name: string, handler: (file: { path: string }) => void) => {
        handlers[name] = handler;
      },
    },
    metadataCache: { on: vi.fn() },
    workspace: { onLayoutReady: vi.fn(), on: vi.fn() },
  } as unknown as App;
  const store = new MemoryStore();
  const id = await store.createAgent('Worker');
  await store.patchAgent(id, { runtime: 'fake' });
  const runtime = new FakeRuntime();
  const detect = vi.spyOn(runtime, 'detect');
  const plugin = new AgentHQPlugin(app, {} as PluginManifest);
  await plugin.onload();
  const chat = new ChatService({
    store,
    adapters: [runtime],
    settings: () => plugin.settings,
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
  });
  await chat.initialize();
  plugin.chat = chat;
  Object.assign(plugin, { store });
  mocks.adapters.mockReturnValue([runtime]);
  return { plugin, chat, handlers, detect, runtime };
}

describe('plugin runtime refresh wiring', () => {
  it('keeps refreshing note snapshots without detecting on rapid managed changes', async () => {
    const { plugin, handlers, detect, chat } = await fixture();
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    for (let batch = 0; batch < 3; batch++) {
      for (const folder of ['Agents', 'Skills', 'Tasks', 'Activity'])
        handlers.modify!({ path: `Mesa/${folder}/changed.md` });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    expect(detect).toHaveBeenCalledTimes(1);
    await chat.dispose();
    expect(plugin.settings.runtimePathOverride).toBe('');
  });

  it('rebuilds adapters and re-detects only when the runtime path override changes', async () => {
    const { plugin, detect, chat } = await fixture();
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    await plugin.saveSettings();
    expect(detect).toHaveBeenCalledTimes(1);
    for (const value of ['/t', '/tools', '/tools/runtime']) {
      plugin.settings.runtimePathOverride = value;
      await plugin.saveSettings();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(detect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.adapters).toHaveBeenCalledWith(
      expect.objectContaining({ runtimePathOverride: '/tools/runtime' }),
    );
    expect(detect).toHaveBeenCalledTimes(2);
    await plugin.saveSettings();
    expect(detect).toHaveBeenCalledTimes(2);
    await chat.dispose();
  });
});
