import { FuzzySuggestModal, Modal, Notice, Setting, type App } from 'obsidian';
import {
  CONTEXT_LEVELS,
  DEFAULT_CONTEXT_LEVEL,
  MEMORY_CHOICES,
  PROJECT_STATUSES,
  type ContextLevel,
  type MemoryChoice,
  type Project,
} from '../core/projects';
import { CONTEXT_LEVEL_LABELS, MEMORY_CHOICE_LABELS } from '../core/memory';
import type { WorkspaceActions } from '../core/workspace';
import { filterPickItems, toggleIn } from '../core/pickList';

/** Lists projects, with "New project" first; choosing one opens its form. */
export function pickProject(app: App, workspace: WorkspaceActions): void {
  const projects = workspace.getSnapshot().projects ?? [];
  class ProjectPicker extends FuzzySuggestModal<Project | null> {
    getItems(): (Project | null)[] {
      return [null, ...projects];
    }
    getItemText(item: Project | null): string {
      return item ? item.name : 'New project…';
    }
    onChooseItem(item: Project | null): void {
      openProjectForm(app, workspace, item);
    }
  }
  new ProjectPicker(app).open();
}

interface PickItem {
  id: string;
  label: string;
  /** Lower-case text the search box matches against. */
  search: string;
}

/** A heading with a count, a search box, and one toggle per item. Ticked items stay ticked when filtered out. With `levels`, each ticked item also gets its context level. */
function togglePicker(
  parent: HTMLElement,
  title: string,
  items: PickItem[],
  selected: string[],
  levels?: Record<string, ContextLevel>,
): void {
  const heading = new Setting(parent).setName(title).setHeading();
  const count = () => heading.setName(`${title} (${selected.length} selected)`);
  count();
  const list = parent.createDiv();
  let query = '';
  const render = () => {
    list.empty();
    for (const item of filterPickItems(items, query)) {
      const setting = new Setting(list).setName(item.label);
      if (levels && selected.includes(item.id))
        setting.addDropdown((drop) => {
          for (const level of CONTEXT_LEVELS)
            drop.addOption(level, CONTEXT_LEVEL_LABELS[level]);
          drop
            .setValue(levels[item.id] ?? DEFAULT_CONTEXT_LEVEL)
            .onChange((value) => (levels[item.id] = value as ContextLevel));
        });
      setting.addToggle((toggle) =>
        toggle.setValue(selected.includes(item.id)).onChange((on) => {
          toggleIn(selected, item.id, on);
          count();
          if (levels) render();
        }),
      );
    }
  };
  new Setting(parent).addSearch((search) =>
    search.setPlaceholder(`Search ${title.toLowerCase()}`).onChange((value) => {
      query = value;
      render();
    }),
  );
  render();
}

/** Asks before a project note is trashed. Chats and tasks keep their history. */
function confirmDelete(
  app: App,
  workspace: WorkspaceActions,
  project: Project,
  onDone: () => void,
): void {
  class ConfirmDelete extends Modal {
    onOpen(): void {
      this.setTitle(`Delete project ${project.name}?`);
      this.contentEl.createEl('p', {
        text: "The note is moved to Obsidian's trash and can be restored. Chats and tasks keep their history.",
      });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button
            .setButtonText('Delete')
            .setClass('mod-warning')
            .onClick(async () => {
              try {
                await workspace.deleteProject(project.path);
                this.close();
                onDone();
              } catch (error) {
                workspace.reportError(error);
              }
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new ConfirmDelete(app).open();
}

/** The project form: every field the project note holds. Archive hides the project and keeps its note. */
export function openProjectForm(
  app: App,
  workspace: WorkspaceActions,
  existing: Project | null,
): void {
  class ProjectForm extends Modal {
    onOpen(): void {
      const snapshot = workspace.getSnapshot();
      this.setTitle(existing ? `Project: ${existing.name}` : 'New project');
      const memoryChoice: MemoryChoice | '' = existing?.memoryModel ?? '';
      const draft = {
        name: existing?.name ?? '',
        status: existing?.status ?? 'planned',
        goal: existing?.goal ?? '',
        deadline: existing?.deadline ?? '',
        outputFolder: existing?.outputFolder ?? '',
        cost: existing?.costLimitUsd?.toString() ?? '',
        teams: [...(existing?.teams ?? [])],
        agents: [...(existing?.agents ?? [])],
        skills: [...(existing?.skills ?? [])],
        instructions: existing?.instructions ?? '',
        memoryModel: memoryChoice,
        levels: { ...(existing?.contextLevels ?? {}) } as Record<
          string,
          ContextLevel
        >,
      };
      new Setting(this.contentEl).setName('Name').addText((text) =>
        text
          .setValue(draft.name)
          .setDisabled(!!existing)
          .onChange((value) => (draft.name = value)),
      );
      new Setting(this.contentEl)
        .setName('Goal')
        .addText((text) =>
          text.setValue(draft.goal).onChange((value) => (draft.goal = value)),
        );
      new Setting(this.contentEl)
        .setName('Instructions')
        .addTextArea((area) => {
          area
            .setValue(draft.instructions)
            .onChange((value) => (draft.instructions = value));
          area.inputEl.rows = 8;
        });
      new Setting(this.contentEl).setName('Status').addDropdown((drop) => {
        for (const status of PROJECT_STATUSES) drop.addOption(status, status);
        drop
          .setValue(draft.status)
          .onChange((value) => (draft.status = value as typeof draft.status));
      });
      new Setting(this.contentEl)
        .setName('Deadline (optional)')
        .addText((text) =>
          text
            .setValue(draft.deadline)
            .setPlaceholder('2026-12-31')
            .onChange((value) => (draft.deadline = value)),
        );
      new Setting(this.contentEl)
        .setName('Output folder (optional)')
        .setDesc(
          'A vault folder for this project’s finished work. Its runs may write there; drafts stay in Work.',
        )
        .addText((text) =>
          text
            .setValue(draft.outputFolder)
            .setPlaceholder('Projects/Sales output')
            .onChange((value) => (draft.outputFolder = value)),
        );
      new Setting(this.contentEl)
        .setName('Cost limit, USD (optional)')
        .addText((text) =>
          text.setValue(draft.cost).onChange((value) => (draft.cost = value)),
        );
      new Setting(this.contentEl)
        .setName('Memory model')
        .setDesc('Inherit uses the vault setting in Obi-I settings.')
        .addDropdown((drop) => {
          drop.addOption('', 'Inherit vault setting');
          for (const choice of MEMORY_CHOICES)
            drop.addOption(choice, MEMORY_CHOICE_LABELS[choice]);
          drop
            .setValue(draft.memoryModel)
            .onChange(
              (value) => (draft.memoryModel = value as MemoryChoice | ''),
            );
        });
      if (existing) {
        const info = new Setting(this.contentEl)
          .setName('Project memory')
          .setDesc('Loading…');
        // The callbacks use block bodies: returning the Setting would make the promise resolve with a thenable.
        void workspace.projectMemoryInfo(existing.path).then(
          (memory) => {
            info.setDesc(
              `Model: ${memory.model} · Memory notes: ${memory.notes}${memory.lastContextWords === null ? '' : ` · Last run context: ${memory.lastContextWords} words`}`,
            );
          },
          () => {
            info.setDesc('Unavailable right now.');
          },
        );
      }
      togglePicker(
        this.contentEl,
        'Teams',
        snapshot.groups.map((group) => ({
          id: group.id,
          label: group.name,
          search: group.name.toLowerCase(),
        })),
        draft.teams,
      );
      togglePicker(
        this.contentEl,
        'Agents',
        snapshot.agents.map((agent) => ({
          id: agent.id,
          label: agent.name,
          search: `${agent.name} ${agent.role}`.toLowerCase(),
        })),
        draft.agents,
        draft.levels,
      );
      togglePicker(
        this.contentEl,
        'Skills',
        snapshot.skills.map((skill) => ({
          id: skill.path,
          label: skill.name,
          search: skill.name.toLowerCase(),
        })),
        draft.skills,
      );
      new Setting(this.contentEl)
        .addButton((button) => {
          if (existing)
            button
              .setButtonText('Delete')
              .setClass('mod-warning')
              .onClick(() =>
                confirmDelete(app, workspace, existing, () => this.close()),
              );
          return button;
        })
        .addButton((button) => {
          if (existing?.archived)
            button.setButtonText('Unarchive').onClick(async () => {
              try {
                await workspace.setProjectArchived(existing.path, false);
                this.close();
              } catch (error) {
                workspace.reportError(error);
              }
            });
          return button;
        })
        .addButton((button) => {
          if (existing && !existing.archived)
            button.setButtonText('Archive').onClick(async () => {
              try {
                await workspace.archiveProject(existing.path);
                this.close();
              } catch (error) {
                workspace.reportError(error);
              }
            });
          return button;
        })
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button
            .setButtonText('Save')
            .setCta()
            .onClick(async () => {
              try {
                const cost = draft.cost.trim() ? Number(draft.cost) : undefined;
                if (cost !== undefined && (!Number.isFinite(cost) || cost < 0))
                  throw new Error('The cost limit must be a positive number.');
                await workspace.saveProject({
                  path: existing?.path,
                  name: draft.name.trim() || 'Project',
                  status: draft.status,
                  goal: draft.goal,
                  deadline: draft.deadline.trim() || undefined,
                  outputFolder: draft.outputFolder.trim() || undefined,
                  costLimitUsd: cost,
                  teams: draft.teams,
                  agents: draft.agents,
                  skills: draft.skills,
                  memoryModel:
                    draft.memoryModel === '' ? undefined : draft.memoryModel,
                  contextLevels: Object.fromEntries(
                    Object.entries(draft.levels).filter(([id]) =>
                      draft.agents.includes(id),
                    ),
                  ),
                  archived: existing?.archived ?? false,
                  instructions: draft.instructions,
                });
                new Notice('Project saved.');
                this.close();
              } catch (error) {
                workspace.reportError(error);
              }
            }),
        );
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new ProjectForm(app).open();
}
