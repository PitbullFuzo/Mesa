import {
  Notice,
  PluginSettingTab,
  Setting,
  type App,
  type SettingDefinitionItem,
  type TextComponent,
} from 'obsidian';
import type AgentHQPlugin from '../main';
import { IMPORT_SKILLS_LABEL } from '../core/runtimes/skills';
import { browserUnavailableReason } from '../core/browser';

import { MEMORY_CHOICE_LABELS } from '../core/memory';
import { MEMORY_CHOICES, type MemoryChoice } from '../core/projects';
import {
  EXCLUDED_FILES_KEY,
  excludedFilesWith,
  isExcluded,
} from '../core/folders';
import { GRAPH_AI_PRIVACY } from '../core/graphAi';
import { HELP_URL } from '../core/guide';
import {
  BUILTIN_NOTE_SKILLS,
  newNoteType,
  noteTypeProblem,
  type NoteType,
} from '../core/noteTypes';
import { runtimeModelList } from '../core/runtimes/modelLists';
import { freeModels } from '../core/models';
import { confirmAction } from './modals';
import { DEFAULT_M365_CLIENT_ID } from '../core/m365/auth';
import { ensureFolder } from '../core/folders';
import { LEGACY_TEAM_FOLDERS, renameTeamFolder } from '../core/teamFolder';

/** Obsidian keeps its settings in the vault config; these two calls are not in the public typings. */
interface VaultConfig {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}
/** One row (or group of rows) of the settings page. */
interface SettingSection {
  name: string;
  desc?: string;
  aliases?: string[];
  build: (containerEl: HTMLElement) => void;
}

export class AgentHQSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgentHQPlugin,
  ) {
    super(app, plugin);
  }

  /** Settings → Note destinations: where agents with a note type ticked save finished notes in the real vault. */
  private noteDestinations(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Note destinations').setHeading();
    new Setting(containerEl).setDesc(
      'An agent you tick a note type for (in its Setup) may create and edit notes in that folder of your vault, and nowhere else. Folders are created when you leave the box. Each built-in type has a note skill on the Skills page that you can edit.',
    );
    const root = this.plugin.settings.agenthqFolder;
    const configDir = this.app.vault.configDir;
    const save = async (types: NoteType[], changed?: NoteType) => {
      if (changed?.enabled) {
        const problem = noteTypeProblem(changed, root, configDir);
        if (problem) {
          new Notice(`${changed.label}: ${problem}`);
          this.redraw();
          return;
        }
        await ensureFolder(
          {
            exists: (path) => this.app.vault.adapter.exists(path),
            createFolder: async (path) => {
              await this.app.vault.createFolder(path);
            },
          },
          changed.folder.replace(/\/+$/, ''),
        );
      }
      this.plugin.settings.noteTypes = types;
      await this.plugin.saveSettings();
      this.plugin.noteTypesChanged();
    };
    const replace = (type: NoteType) =>
      this.plugin.settings.noteTypes.map((entry) =>
        entry.id === type.id ? type : entry,
      );
    for (const type of this.plugin.settings.noteTypes) {
      const row = new Setting(containerEl).setName(type.label);
      row.addText((text) => {
        text.setPlaceholder('Folder in your vault').setValue(type.folder);
        // Saved when the box loses focus, so a folder is not created for every letter typed.
        text.inputEl.addEventListener('blur', () => {
          const folder = text.getValue().trim();
          if (folder !== type.folder) {
            const next = { ...type, folder };
            void save(replace(next), next);
          }
        });
      });
      row.addToggle((toggle) =>
        toggle.setValue(type.enabled).onChange((enabled) => {
          const next = { ...type, enabled };
          void save(replace(next), next);
        }),
      );
      if (!BUILTIN_NOTE_SKILLS[type.id])
        row.addButton((button) =>
          button.setButtonText('Remove').onClick(() => {
            void save(
              this.plugin.settings.noteTypes.filter(
                (entry) => entry.id !== type.id,
              ),
            ).then(() => this.redraw());
          }),
        );
    }
    let label = '';
    let folder = '';
    new Setting(containerEl)
      .setName('Add a note type')
      .setDesc('A name (for example "Recipes") and its vault folder.')
      .addText((text) =>
        text.setPlaceholder('Name').onChange((value) => (label = value)),
      )
      .addText((text) =>
        text.setPlaceholder('Folder').onChange((value) => (folder = value)),
      )
      .addButton((button) =>
        button.setButtonText('Add').onClick(() => {
          if (!label.trim()) return;
          const type = newNoteType(
            label,
            folder || label,
            this.plugin.settings.noteTypes,
          );
          void save([...this.plugin.settings.noteTypes, type], type).then(() =>
            this.redraw(),
          );
        }),
      );
  }

  /** Settings → Connectors: Microsoft 365 sign-in. The owner signs in on Microsoft's page; no password is handled here. */
  private connectors(containerEl: HTMLElement): void {
    const m365 = this.plugin.workspace.getSnapshot().m365;
    new Setting(containerEl).setName('Connectors').setHeading();
    new Setting(containerEl)
      .setName('Microsoft 365: application (client) ID')
      .setDesc(
        'Leave empty to use the app that comes with Mesa: just press Sign in. Microsoft may call it "unverified" on its screen until the publisher is verified. To use your own app registration in Microsoft Entra (public client, "Allow public client flows" on, no secret), paste its ID here.',
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_M365_CLIENT_ID)
          .setValue(this.plugin.settings.m365ClientId)
          .onChange(async (value) => {
            this.plugin.settings.m365ClientId = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Microsoft 365: account type')
      .setDesc('Personal (outlook.com, live.com) or work or school.')
      .addDropdown((drop) =>
        drop
          .addOption('consumers', 'Personal Microsoft account')
          .addOption('common', 'Work or school account')
          .setValue(this.plugin.settings.m365Authority)
          .onChange(async (value) => {
            this.plugin.settings.m365Authority =
              value === 'common' ? 'common' : 'consumers';
            await this.plugin.saveSettings();
          }),
      );
    const row = new Setting(containerEl)
      .setName('Microsoft 365')
      .setDesc(
        m365?.connected
          ? `Connected${m365.account ? ` as ${m365.account}` : ' (name unavailable)'}.${m365.needsPermission ? ' Microsoft now asks for one more permission (your basic profile): disconnect and sign in once more to approve it.' : ''} Agents read mail, calendar and OneDrive only when you tick it in their Setup; every send, reply, forward, delete, invitation answer, share and file write needs your Approve card. The sign-in is kept in a file outside your vault, not encrypted. Disconnect removes it here; to also end Microsoft's access, remove the app in your Microsoft account's app permissions.`
          : 'Not connected. Sign in opens a window with a code and a button for Microsoft’s own page. Access: read and write mail, calendar and OneDrive files (writes only after your approval).',
      );
    if (m365?.connected)
      row.addButton((button) =>
        button.setButtonText('Disconnect').onClick(() => {
          button.setDisabled(true);
          this.plugin
            .disconnectM365()
            .catch((error: unknown) => this.plugin.workspace.reportError(error))
            .finally(() => this.redraw());
        }),
      );
    else
      row.addButton((button) =>
        button.setButtonText('Sign in').onClick(() => {
          button.setDisabled(true);
          this.plugin
            .connectM365()
            .catch((error: unknown) => this.plugin.workspace.reportError(error))
            .finally(() => this.redraw());
        }),
      );
  }

  /** Every row of the settings page, with the words Obsidian's settings search matches on. */
  private sections(): SettingSection[] {
    return [
      {
        name: 'Help & feedback',
        desc: 'How-tos and a feedback form on trabalhoia.com.',
        aliases: ['help', 'feedback', 'website'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Help & feedback')
            .setDesc(
              'How-tos and a feedback form on trabalhoia.com. It opens in your browser; nothing is sent from here.',
            )
            .addButton((button) =>
              button.setButtonText('Open trabalhoia.com').onClick(() => {
                window.open(HELP_URL);
              }),
            );
        },
      },
      {
        name: 'Mesa folder',
        desc: 'Vault folder for team notes, and renaming it from an earlier name.',
        aliases: ['folder', 'team folder', 'rename', 'obi-i', 'agenthq'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Mesa folder')
            .setDesc(
              'Vault-relative folder for team notes. Reload the plugin after changing it.',
            )
            .addText((text) =>
              text
                .setValue(this.plugin.settings.agenthqFolder)
                .onChange(async (value) => {
                  if (value.trim()) {
                    this.plugin.settings.agenthqFolder = value.trim();
                    await this.plugin.saveSettings();
                  }
                }),
            );

          const legacy = LEGACY_TEAM_FOLDERS.find(
            (name) => name === this.plugin.settings.agenthqFolder,
          );
          if (legacy && this.app.vault.getFolderByPath(legacy))
            new Setting(containerEl)
              .setName('Rename folder to Mesa')
              .setDesc(
                `Your team still lives in the ${legacy} folder from before the rename. Renaming updates the links to it. Nothing is moved unless you press the button. Mesa reloads itself afterwards.`,
              )
              .addButton((button) =>
                button.setButtonText('Rename folder').onClick(async () => {
                  const folder = this.app.vault.getFolderByPath(legacy);
                  if (!folder) return;
                  if (this.app.vault.getAbstractFileByPath('Mesa')) {
                    new Notice('A file or folder called Mesa already exists.');
                    return;
                  }
                  const confirmed = await confirmAction(
                    this.app,
                    `Rename the ${legacy} folder?`,
                    `The folder ${legacy} becomes Mesa, with everything in it. Links to your notes are updated, and Mesa reloads itself.`,
                  );
                  if (!confirmed) return;
                  // Vault events for the old and new folder are ignored until the plugin reloads below.
                  this.plugin.teamFolderGuard.begin();
                  try {
                    await renameTeamFolder({
                      settings: this.plugin.settings,
                      to: 'Mesa',
                      rename: async (from, to) => {
                        const current = this.app.vault.getFolderByPath(from);
                        if (!current)
                          throw new Error(`The folder ${from} was not found.`);
                        await this.app.fileManager.renameFile(current, to);
                      },
                      save: () => this.plugin.saveSettings(),
                    });
                  } catch (error) {
                    this.plugin.teamFolderGuard.cancel();
                    throw error;
                  }
                  this.plugin.renameHiddenFolder(legacy, 'Mesa');
                  new Notice('Folder renamed. Reloading Mesa…');
                  await this.plugin.reloadPlugin();
                }),
              );
        },
      },
      {
        name: 'Folders agents may touch',
        desc: 'Other folders agents may use, one per line.',
        aliases: ['allowed folders', 'outside folders', 'permissions'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Folders agents may touch')
            .setDesc(
              'Default team Work folders are always allowed. Add one other folder per line. Each agent may use only the folders you tick in its Setup.',
            )
            .addTextArea((text) => {
              let saved = [...this.plugin.settings.allowedFolders];
              text.setValue(saved.join('\n'));
              // Saved when the box loses focus. Adding a folder asks first, because agents you tick can change it.
              text.inputEl.addEventListener('blur', () => {
                const next = text
                  .getValue()
                  .split(/\r?\n/)
                  .map((folder) => folder.trim())
                  .filter(Boolean);
                const added = next.some((folder) => !saved.includes(folder));
                const save = async () => {
                  this.plugin.settings.allowedFolders = next;
                  saved = next;
                  await this.plugin.saveSettings();
                  this.plugin.workspace.setAllowedFolders(next);
                };
                if (!added) {
                  void save();
                  return;
                }
                void confirmAction(
                  this.app,
                  'Add a folder for agents?',
                  'Agents you tick will be able to create, change and delete files here. Back it up first.',
                ).then(async (confirmed) => {
                  if (confirmed) await save();
                  else text.setValue(saved.join('\n'));
                });
              });
            });
        },
      },
      {
        name: 'Hide Mesa from search & graph',
        desc: "Adds the Mesa folder to Obsidian's Excluded files.",
        aliases: ['excluded files', 'graph', 'search', 'hide'],
        build: (containerEl) => {
          const vaultConfig = this.app.vault as unknown as VaultConfig;
          const excluded = (): string[] => {
            const value = vaultConfig.getConfig(EXCLUDED_FILES_KEY);
            return Array.isArray(value)
              ? value.filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : [];
          };
          const agentFolder = `${this.plugin.settings.agenthqFolder}/`;
          const hidden = isExcluded(excluded(), agentFolder);
          const hideDescription = (on: boolean) =>
            on
              ? "Mesa is in Obsidian's Excluded files, so search and the graph skip it."
              : "Adds Mesa to Obsidian's Excluded files, so search and the graph skip it.";
          let isHidden = hidden;
          const hideRow = new Setting(containerEl)
            .setName('Hide Mesa from search & graph')
            .setDesc(hideDescription(isHidden));
          hideRow.addButton((button) => {
            button
              .setButtonText(isHidden ? 'Show again' : 'Hide Mesa')
              .onClick(async () => {
                const hide = !isHidden;
                const confirmed = await confirmAction(
                  this.app,
                  'This changes an Obsidian setting',
                  hide
                    ? `${agentFolder} will be added to Obsidian's Excluded files. Search and the graph will skip your agent notes.`
                    : `${agentFolder} will be removed from Obsidian's Excluded files.`,
                );
                if (!confirmed) return;
                vaultConfig.setConfig(
                  EXCLUDED_FILES_KEY,
                  excludedFilesWith(excluded(), agentFolder, hide),
                );
                isHidden = hide;
                button.setButtonText(isHidden ? 'Show again' : 'Hide Mesa');
                hideRow.setDesc(hideDescription(isHidden));
              });
          });
        },
      },
      {
        name: 'Import skills',
        desc: "Copy installed skill notes into the team's Skills folder.",
        aliases: ['skills', 'claude code skills'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName(IMPORT_SKILLS_LABEL)
            .setDesc(
              'Copy installed skill notes into this team’s Skills folder. Existing notes are never overwritten; linked source folders are skipped.',
            )
            .addButton((button) =>
              button.setButtonText('Import skills').onClick(async () => {
                button.setDisabled(true);
                try {
                  await this.plugin.importInstalledSkills();
                } catch (error) {
                  this.plugin.workspace.reportError(error);
                } finally {
                  button.setDisabled(false);
                }
              }),
            );
        },
      },
      {
        name: 'Browser engine',
        desc: 'Which browser engine agents use for browser control.',
        aliases: ['browser', 'playwright', 'hermes'],
        build: (containerEl) => {
          const browser = this.plugin.workspace.getSnapshot().browser;
          new Setting(containerEl)
            .setName('Browser engine')
            .setDesc(
              browser?.hint ??
                'Playwright is the default. Hermes browser remains disabled until isolation and confinement are verified.',
            )
            .addDropdown((drop) => {
              drop
                .addOption('playwright', 'Playwright (Claude Code)')
                .addOption('hermes', 'Hermes browser — unavailable')
                .setValue(this.plugin.settings.browserEngine);
              const playwright = Array.from(drop.selectEl.options).find(
                (o) => o.value === 'playwright',
              );
              if (playwright && browser?.engine === 'playwright') {
                playwright.disabled = !browser.available;
                playwright.title = browser.hint;
              }
              const option = Array.from(drop.selectEl.options).find(
                (o) => o.value === 'hermes',
              );
              if (option) {
                option.disabled = true;
                option.title = browserUnavailableReason(
                  'hermes',
                  false,
                  'hermes',
                );
              }
              drop.onChange(async (value) => {
                this.plugin.settings.browserEngine =
                  value === 'hermes' ? 'hermes' : 'playwright';
                await this.plugin.saveSettings();
                await this.plugin.refreshBrowserTools();
                this.redraw();
              });
            });
        },
      },
      {
        name: 'Set up browser tools',
        desc: 'Download Playwright MCP and Chromium after a size confirmation.',
        aliases: ['browser', 'playwright', 'chromium', 'download'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Set up browser tools')
            .setDesc(
              'Downloads pinned Playwright MCP and Chromium only after a size confirmation. Does not import browser cookies or logins.',
            )
            .addButton((button) =>
              button.setButtonText('Set up browser tools').onClick(async () => {
                button.setDisabled(true);
                try {
                  await this.plugin.setupBrowserTools();
                  this.redraw();
                } catch (error) {
                  this.plugin.workspace.reportError(error);
                } finally {
                  button.setDisabled(false);
                }
              }),
            );
        },
      },
      {
        name: 'Connectors',
        desc: 'Microsoft 365 sign-in: client ID, account type, connect and disconnect.',
        aliases: [
          'microsoft',
          'outlook',
          'onedrive',
          'calendar',
          'mail',
          'sign in',
          'client id',
        ],
        build: (containerEl) => {
          this.connectors(containerEl);
        },
      },
      {
        name: 'Note destinations',
        desc: 'Which vault folders agents may write meeting notes, research, wiki and permanent notes to.',
        aliases: [
          'meeting notes',
          'research',
          'wiki',
          'permanent notes',
          'folders',
        ],
        build: (containerEl) => {
          this.noteDestinations(containerEl);
        },
      },
      {
        name: 'Press Enter to send',
        desc: 'Whether Enter sends a message or starts a new line.',
        aliases: ['enter', 'send', 'keyboard'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Press Enter to send')
            .setDesc(
              'On: Enter sends and Shift+Enter starts a new line. Off: Enter starts a new line and the Send button sends.',
            )
            .addToggle((toggle) =>
              toggle
                .setValue(this.plugin.settings.enterToSend)
                .onChange(async (value) => {
                  this.plugin.settings.enterToSend = value;
                  await this.plugin.saveSettings();
                  this.plugin.workspace.setEnterToSend(value);
                }),
            );
        },
      },
      {
        name: 'Project memory model',
        desc: 'Which model writes project memory notes.',
        aliases: ['memory', 'projects'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Project memory model')
            .setDesc(
              'Writes memory notes for projects after tasks finish. Auto uses the cheapest installed runtime. Off keeps only the project log, with no model calls.',
            )
            .addDropdown((drop) => {
              for (const choice of MEMORY_CHOICES)
                drop.addOption(choice, MEMORY_CHOICE_LABELS[choice]);
              drop
                .setValue(this.plugin.settings.memoryModel)
                .onChange(async (value) => {
                  this.plugin.settings.memoryModel = value as MemoryChoice;
                  await this.plugin.saveSettings();
                });
            });
        },
      },
      {
        name: 'Graph AI concepts',
        desc: 'Let a cheap model suggest concepts and related notes for the graph map.',
        aliases: ['graph', 'ai', 'concepts'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Graph AI concepts (off by default)')
            .setDesc(
              `Lets a cheap model suggest key concepts and related notes for notes with few links, into the Graph map only. Each suggestion must name a real note and a phrase that appears in the note, or it is dropped. Uses the Project memory model. ${GRAPH_AI_PRIVACY}`,
            )
            .addToggle((toggle) =>
              toggle
                .setValue(this.plugin.settings.graphAi)
                .onChange(async (value) => {
                  this.plugin.settings.graphAi = value;
                  await this.plugin.saveSettings();
                }),
            );
        },
      },
      {
        name: 'Graph AI spend so far',
        desc: 'Total spent on the optional graph AI pass.',
        aliases: ['cost', 'graph'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Graph AI spend so far')
            .setDesc(
              `$${this.plugin.graphAiTotal.toFixed(4)} in total. ${this.plugin.graphAiStatus || 'The pass has not run yet.'} Each rebuild adds a line to the Activity log.`,
            );
        },
      },
      {
        name: 'Graph AI model',
        desc: 'Model used for the graph AI pass.',
        aliases: ['graph', 'opencode', 'free models'],
        build: (containerEl) => {
          let graphModelText: TextComponent | undefined;
          new Setting(containerEl)
            .setName('Graph AI model')
            .setDesc(
              'Empty uses the runtime default: with OpenCode that is the free model opencode/nemotron-3.5-lightning-free. Type a provider/model to use another one.',
            )
            .addText((text) => {
              graphModelText = text;
              text
                .setPlaceholder('Empty = default')
                .setValue(this.plugin.settings.graphAiModel)
                .onChange(async (value) => {
                  this.plugin.settings.graphAiModel = value.trim();
                  await this.plugin.saveSettings();
                });
            })
            // Only shown when OpenCode is installed and lists models marked free: pick one instead of typing it.
            .addDropdown((drop) => {
              drop.selectEl.hidden = true;
              drop.addOption('', 'Free OpenCode models…');
              drop.onChange(async (value) => {
                if (!value) return;
                this.plugin.settings.graphAiModel = value;
                graphModelText?.setValue(value);
                await this.plugin.saveSettings();
                drop.setValue('');
              });
              void runtimeModelList('opencode')
                .then((list) => {
                  const free = freeModels(list);
                  for (const choice of free)
                    drop.addOption(choice.value, choice.label);
                  drop.selectEl.hidden = free.length === 0;
                })
                .catch(() => {
                  /* OpenCode is not installed or did not answer: the box stays free text. */
                });
            });
        },
      },
      {
        name: 'Delete all chat history',
        desc: "Move every agent's chat notes to the trash.",
        aliases: ['chats', 'history', 'trash'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Delete all chat history')
            .setDesc(
              "Moves every agent's chat notes to the trash after you confirm. Agents then start fresh conversations.",
            )
            .addButton((button) =>
              button
                .setButtonText('Delete all chat history')
                .setClass('mod-warning')
                .onClick(async () => {
                  button.setDisabled(true);
                  try {
                    await this.plugin.workspace.deleteAllHistory();
                  } catch (error) {
                    this.plugin.workspace.reportError(error);
                  } finally {
                    button.setDisabled(false);
                  }
                }),
            );
        },
      },
      {
        name: 'Restore Obi',
        desc: 'Recreate the built-in assistant if it was deleted.',
        aliases: ['assistant', 'obi'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Restore Obi')
            .setDesc(
              'Recreates the built-in assistant if it was deleted. Existing notes are never overwritten.',
            )
            .addButton((button) =>
              button.setButtonText('Restore Obi').onClick(async () => {
                button.setDisabled(true);
                try {
                  await this.plugin.workspace.restoreObi();
                } catch (error) {
                  this.plugin.workspace.reportError(error);
                } finally {
                  button.setDisabled(false);
                }
              }),
            );
        },
      },
      {
        name: 'Max parallel runs',
        aliases: ['parallel', 'limits'],
        build: (containerEl) =>
          this.addLimit(containerEl, 'maxParallelRuns', 'Max parallel runs'),
      },
      {
        name: 'Max delegation depth',
        aliases: ['delegation', 'limits'],
        build: (containerEl) =>
          this.addLimit(
            containerEl,
            'maxDelegationDepth',
            'Max delegation depth',
          ),
      },
      {
        name: 'Max runs per request',
        aliases: ['runs', 'limits'],
        build: (containerEl) =>
          this.addLimit(
            containerEl,
            'maxRunsPerRequest',
            'Max runs per request',
          ),
      },
      {
        name: 'Default verifier attempts',
        aliases: ['verifier', 'limits'],
        build: (containerEl) =>
          this.addLimit(
            containerEl,
            'defaultVerifierAttempts',
            'Default verifier attempts',
          ),
      },
      {
        name: 'Runtime path override',
        desc: "Optional path to the AI tool's program.",
        aliases: ['claude code', 'codex', 'opencode', 'hermes', 'path'],
        build: (containerEl) => {
          new Setting(containerEl)
            .setName('Runtime path override')
            .setDesc(
              'Optional executable path for the v1 runtime. Changing it refreshes runtime detection.',
            )
            .addText((text) =>
              text
                .setValue(this.plugin.settings.runtimePathOverride)
                .onChange(async (value) => {
                  this.plugin.settings.runtimePathOverride = value;
                  await this.plugin.saveSettings();
                }),
            );
        },
      },
    ];
  }

  /**
   * Obsidian 1.13+ settings search: one definition per row, built by the same code display() uses (older versions
   * only call display()). Each definition hides its own placeholder row and puts the real rows in its place.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map((section) => ({
      name: section.name,
      ...(section.desc ? { desc: section.desc } : {}),
      aliases: section.aliases ?? [],
      render: (setting: Setting) => {
        const holder = createDiv();
        section.build(holder);
        setting.settingEl.after(...Array.from(holder.children));
        setting.settingEl.hide();
      },
    }));
  }

  /** Rebuilds the whole page after a change that adds or removes rows. */
  private redraw(): void {
    // display() is deprecated from Obsidian 1.13 in favour of getSettingDefinitions(), but older versions only call it.
    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const section of this.sections()) section.build(containerEl);
  }

  private addLimit(
    containerEl: HTMLElement,
    key:
      | 'maxParallelRuns'
      | 'maxDelegationDepth'
      | 'maxRunsPerRequest'
      | 'defaultVerifierAttempts',
    name: string,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(
        key === 'maxParallelRuns'
          ? 'Maximum simultaneous runs across all chats.'
          : 'A positive whole number. Used by later orchestration steps.',
      )
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.step = '1';
        return text
          .setValue(String(this.plugin.settings[key]))
          .onChange(async (value) => {
            const number = Number(value);
            if (Number.isSafeInteger(number) && number > 0) {
              this.plugin.settings[key] = number;
              await this.plugin.saveSettings();
            }
          });
      });
  }
}
