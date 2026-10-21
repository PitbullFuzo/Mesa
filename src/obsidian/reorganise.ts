import { Modal, Notice, Setting, type App } from 'obsidian';
import type { ChatService } from '../core/chat';
import type { Store } from '../core/store';
import type { Agent } from '../core/model';
import { isVaultSearchable } from '../core/vaultMap';
import {
  applyMoves,
  confirmSummary,
  linksSettingProblem,
  parsePlan,
  planNote,
  planPath,
  planPrompt,
  reviewedMoves,
  undoLogMoves,
  undoLogNote,
  undoMoves,
  validateMoves,
  type Move,
  type Renamer,
} from '../core/reorganise';
import type { WorkspaceActions } from '../core/workspace';
import { confirmAction } from './modals';

export interface ReorganiseDeps {
  app: App;
  chat: ChatService;
  store: Store;
  workspace: WorkspaceActions;
  root: string;
}

/** Obsidian keeps "Automatically update internal links" in the vault config; not in the public typings. */
interface VaultConfig {
  getConfig(key: string): unknown;
}

/** Two-digit padding for file names: 2026-10-20 1430. */
function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * Obsidian's rename: fileManager.renameFile updates the links that point at the file. The target folder is created
 * first, through the vault API, when it does not exist yet. Nothing is deleted.
 */
function obsidianRenamer(app: App): Renamer {
  return {
    async rename(from, to) {
      const file = app.vault.getFileByPath(from);
      if (!file) throw new Error(`No file at ${from}`);
      const folder = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
      let current = '';
      for (const part of folder ? folder.split('/') : []) {
        current = current ? `${current}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(current))
          await app.vault.createFolder(current);
      }
      await app.fileManager.renameFile(file, to);
    },
  };
}

/** Refuses to move anything while Obsidian would not update links. Anything but a real true counts as off. */
function requireLinkUpdates(app: App, action: 'apply' | 'undo'): void {
  const value = (app.vault as unknown as VaultConfig).getConfig(
    'alwaysUpdateLinks',
  );
  const problem = linksSettingProblem(value, action);
  if (problem) throw new Error(problem);
}

/** Progress and Stop while moves run. The moves stop after the one in progress. */
class ProgressModal extends Modal {
  stopRequested = false;
  private readonly line: HTMLElement;
  constructor(
    app: App,
    private readonly total: number,
  ) {
    super(app);
    this.setTitle('Reorganising vault');
    this.line = this.contentEl.createEl('p', { text: `0 of ${total} moved` });
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText('Stop').onClick(() => {
        this.stopRequested = true;
        button.setDisabled(true);
      }),
    );
  }
  progress(done: number): void {
    this.line.setText(`${done} of ${this.total} handled`);
  }
}

/** The newest plan note in Mesa/Activity: the one the owner reviews. */
async function latestPlan(store: Store, root: string) {
  const plans = (await store.loadNotesUnder(`${root}/Activity`))
    .filter((note) => note.name.startsWith('Reorganisation plan'))
    .sort((a, b) => b.path.localeCompare(a.path));
  return plans[0] ?? null;
}

/** The newest undo log that has not been undone yet. */
async function latestUndoLog(store: Store, root: string) {
  const logs = (await store.loadNotesUnder(`${root}/Activity`))
    .filter(
      (note) =>
        note.name.startsWith('Reorganise ') &&
        (note.frontmatter as { undone?: boolean } | null)?.undone !== true,
    )
    .sort((a, b) => b.path.localeCompare(a.path));
  return logs[0] ?? null;
}

/**
 * Asks the chosen agent for a plan through a one-off read-only run (ChatService.planReply) and writes the plan to
 * Mesa/Activity, where agents cannot change it before it is applied.
 */
async function askForPlan(deps: ReorganiseDeps, agent: Agent): Promise<void> {
  const files = deps.app.vault
    .getMarkdownFiles()
    .map((file) => file.path)
    .filter((path) =>
      isVaultSearchable(path, deps.root, deps.app.vault.configDir),
    )
    .sort();
  const reply = await deps.chat.planReply(agent.id, planPrompt(files));
  const parsed = parsePlan(reply.text);
  if (!('plan' in parsed)) throw new Error(parsed.problem);
  const now = stamp();
  const path = planPath(deps.root, now);
  await deps.store.createNote(
    path,
    { agenthq: 'reorganisation-plan', planCostUsd: reply.costUsd },
    planNote(parsed.plan, now),
  );
  await deps.workspace.openNote(path);
  new Notice(
    'Plan ready. Untick the moves you do not want, then apply the reviewed plan.',
  );
}

/** Applies the newest reviewed plan: check the links setting, validate, confirm, move with progress, log the undo. */
async function applyPlan(deps: ReorganiseDeps): Promise<void> {
  requireLinkUpdates(deps.app, 'apply');
  const plan = await latestPlan(deps.store, deps.root);
  if (!plan)
    throw new Error('There is no plan yet. Ask an agent for a plan first.');
  const reviewed = reviewedMoves(plan.body);
  const files = new Set(
    deps.app.vault.getMarkdownFiles().map((file) => file.path),
  );
  const checked = validateMoves(
    reviewed.moves,
    files,
    deps.root,
    deps.app.vault.configDir,
  );
  const skipped = reviewed.problems.length + checked.problems.length;
  if (checked.valid.length === 0)
    throw new Error(
      `No move can be applied.${checked.problems.length ? ` ${checked.problems.slice(0, 3).join(' | ')}` : ''}`,
    );
  const confirmed = await confirmAction(
    deps.app,
    `Move ${checked.valid.length} notes?`,
    `${confirmSummary(checked.valid, skipped)}\n\nLinks are updated. Nothing is deleted. Undo is available afterwards.`,
  );
  if (!confirmed) return;
  const modal = new ProgressModal(deps.app, checked.valid.length);
  modal.open();
  const result = await applyMoves(checked.valid, obsidianRenamer(deps.app), {
    shouldStop: () => modal.stopRequested,
    onProgress: (done) => modal.progress(done),
  });
  modal.close();
  if (result.applied.length) {
    const appliedAt = new Date().toISOString();
    await deps.store.createNote(
      `${deps.root}/Activity/Reorganise ${stamp()}.md`,
      { agenthq: 'reorganisation', appliedAt, undone: false },
      undoLogNote(result.applied, appliedAt).replace(/^---[\s\S]*?---\n/, ''),
    );
  }
  new Notice(
    `Moved ${result.applied.length} notes${result.failed.length ? `; ${result.failed.length} failed` : ''}${result.stopped ? '; stopped early' : ''}.`,
  );
}

/** Moves the last applied batch back. Each file goes back only if its original place is free. */
export async function undoLastReorganisation(
  deps: ReorganiseDeps,
): Promise<void> {
  requireLinkUpdates(deps.app, 'undo');
  const log = await latestUndoLog(deps.store, deps.root);
  if (!log) throw new Error('There is no reorganisation to undo.');
  const entries: Move[] = undoLogMoves(log.body);
  const confirmed = await confirmAction(
    deps.app,
    `Undo ${entries.length} moves?`,
    `${confirmSummary(entries, 0)}\n\nEach note goes back to where it was. Links are updated again.`,
  );
  if (!confirmed) return;
  const result = await undoMoves(
    entries,
    obsidianRenamer(deps.app),
    (path) => deps.app.vault.getAbstractFileByPath(path) !== null,
  );
  await deps.store.saveNote(
    log.path,
    { ...(log.frontmatter as object), undone: true },
    log.body,
  );
  new Notice(
    `Restored ${result.restored.length} notes${result.skipped.length ? `; skipped ${result.skipped.length}` : ''}.`,
  );
}

/** "Reorganise vault…": a backup check first, then ask for a plan, review it, and apply it. */
export function openReorganiseModal(deps: ReorganiseDeps): void {
  void deps.store
    .loadAgents()
    .then(({ agents }) => {
      class ReorganiseForm extends Modal {
        onOpen(): void {
          this.setTitle('Reorganise vault');
          let backedUp = false;
          let agentId = agents[0]?.id ?? '';
          const actions = new Setting(this.contentEl);
          this.contentEl.createEl('p', {
            text: 'Back up your vault first: copy the whole vault folder somewhere safe, or use a backup tool or Git. Then tick the box.',
          });
          this.contentEl.createEl('p', {
            text: 'Only notes (.md) are moved. Images and other files stay where they are.',
          });
          new Setting(this.contentEl)
            .setName('I have a backup')
            .addToggle((toggle) =>
              toggle.onChange((value) => {
                backedUp = value;
              }),
            );
          new Setting(this.contentEl)
            .setName('Agent for the plan')
            .setDesc(
              'It gets the file list in a one-off read-only run, with no vault, web or outside folders.',
            )
            .addDropdown((dropdown) => {
              for (const agent of agents)
                dropdown.addOption(agent.id, agent.name);
              dropdown.setValue(agentId).onChange((value) => {
                agentId = value;
              });
            });
          actions
            .addButton((button) =>
              button.setButtonText('Ask for a plan').onClick(() => {
                if (!backedUp)
                  return new Notice('Tick “I have a backup” first.');
                const agent = agents.find((entry) => entry.id === agentId);
                if (!agent) return new Notice('Choose an agent first.');
                const status = deps.chat.getSnapshot().agents[agent.id]?.status;
                if (status === 'working' || status === 'queued')
                  return new Notice(
                    'This agent is busy. Wait for its reply, then ask for a plan again.',
                  );
                this.close();
                askForPlan(deps, agent).catch((error: unknown) =>
                  deps.workspace.reportError(error),
                );
                return undefined;
              }),
            )
            .addButton((button) =>
              button
                .setButtonText('Apply reviewed plan')
                .setCta()
                .onClick(() => {
                  if (!backedUp)
                    return new Notice('Tick “I have a backup” first.');
                  this.close();
                  applyPlan(deps).catch((error: unknown) =>
                    deps.workspace.reportError(error),
                  );
                  return undefined;
                }),
            );
        }
        onClose(): void {
          this.contentEl.empty();
        }
      }
      new ReorganiseForm(deps.app).open();
    })
    .catch((error: unknown) => deps.workspace.reportError(error));
}
