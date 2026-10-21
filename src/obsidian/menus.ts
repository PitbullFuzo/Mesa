import { TFile, type Menu, type Plugin } from 'obsidian';

export function registerNoteMenus(
  plugin: Plugin,
  ask: (file: TFile) => Promise<void>,
  reportError: (error: unknown) => void,
): void {
  const add = (menu: Menu, file: unknown) => {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    menu.addItem((item) =>
      item
        .setTitle('Ask an agent about this note…')
        .setIcon('message-square')
        .onClick(() => {
          void ask(file).catch(reportError);
        }),
    );
  };
  plugin.registerEvent(plugin.app.workspace.on('file-menu', add));
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu, _editor, view) =>
      add(menu, view.file),
    ),
  );
}
