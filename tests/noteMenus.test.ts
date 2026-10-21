import { expect, it, vi } from 'vitest';
import type { App, Menu, Plugin } from 'obsidian';
import { TFile } from 'obsidian';
import { registerNoteMenus } from '../src/obsidian/menus';

vi.mock('obsidian', () => ({
  TFile: class {
    extension = 'md';
    path = 'Notes/Example.md';
  },
}));
it('adds file and editor actions only for notes and dispatches the chosen note', async () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const on = vi.fn((name: string, handler: (...args: unknown[]) => void) => {
    handlers[name] = handler;
  });
  const registerEvent = vi.fn();
  const ask = vi.fn(async () => {});
  const plugin = {
    app: { workspace: { on } } as unknown as App,
    registerEvent,
  } as unknown as Plugin;
  registerNoteMenus(plugin, ask, vi.fn());
  expect(registerEvent).toHaveBeenCalledTimes(2);
  let chosen: () => void = () => {};
  const item = {
    setTitle: vi.fn().mockReturnThis(),
    setIcon: vi.fn().mockReturnThis(),
    onClick: vi.fn((callback: () => void) => {
      chosen = callback;
    }),
  };
  const addItem = vi.fn((cb: (value: typeof item) => void) => cb(item));
  const menu = { addItem } as unknown as Menu;
  const file = new TFile();
  handlers['file-menu']!(menu, file);
  expect(item.setTitle).toHaveBeenCalledWith('Ask an agent about this note…');
  chosen();
  expect(ask).toHaveBeenCalledWith(file);
  handlers['editor-menu']!(menu, {}, { file });
  expect(addItem).toHaveBeenCalledTimes(2);
  handlers['file-menu']!(menu, { extension: 'png' });
  expect(addItem).toHaveBeenCalledTimes(2);
});
