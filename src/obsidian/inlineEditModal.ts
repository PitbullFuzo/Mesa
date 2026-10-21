import { Modal, Notice, Setting, type App, type Editor } from 'obsidian';
import {
  cleanReplacement,
  groupChanges,
  inlineEditPrompt,
  isBigChange,
  paragraphRange,
  wordDiff,
} from '../core/inlineEdit';
import type { Agent } from '../core/model';
import type { WorkspaceActions } from '../core/workspace';

/** Characters of the note kept before and after the passage as context for the agent. */
const CONTEXT_CHARS = 600;

/** The text the edit applies to: the selection, or else the paragraph around the cursor. Null when there is neither. */
export function editTarget(editor: Editor): {
  from: { line: number; ch: number };
  to: { line: number; ch: number };
} | null {
  if (editor.somethingSelected()) {
    const [start, end] = [editor.getCursor('from'), editor.getCursor('to')];
    return { from: start, to: end };
  }
  const lines = editor.getValue().split('\n');
  const line = editor.getCursor().line;
  const range = paragraphRange(lines, line);
  return range
    ? {
        from: { line: range.from, ch: 0 },
        to: { line: range.to, ch: lines[range.to]!.length },
      }
    : null;
}

/**
 * "Edit selection with an agent": an instruction and an agent, a one-off read-only run, then a word-level preview.
 * Nothing is written before Accept; Accept replaces exactly the chosen text through the editor, so Ctrl+Z undoes it.
 */
export class InlineEditModal extends Modal {
  private agentId: string;
  private instruction = '';
  private runner: AbortController | null = null;
  private readonly original: string;
  private readonly before: string;
  private readonly after: string;

  constructor(
    app: App,
    private readonly workspace: WorkspaceActions,
    private readonly editor: Editor,
    private readonly target: NonNullable<ReturnType<typeof editTarget>>,
    private readonly agents: Agent[],
    lastAgentId: string,
    private readonly remember: (agentId: string) => void,
    private layout: '' | 'inline' | 'blocks',
    private readonly rememberLayout: (layout: 'inline' | 'blocks') => void,
  ) {
    super(app);
    this.agentId = agents.some((agent) => agent.id === lastAgentId)
      ? lastAgentId
      : (agents[0]?.id ?? '');
    this.original = editor.getRange(target.from, target.to);
    const whole = editor.getValue();
    const start = editor.posToOffset(target.from);
    const end = editor.posToOffset(target.to);
    this.before = whole.slice(Math.max(0, start - CONTEXT_CHARS), start);
    this.after = whole.slice(end, end + CONTEXT_CHARS);
  }

  onOpen(): void {
    this.setTitle('Edit with an agent');
    this.showPrompt();
  }

  onClose(): void {
    this.runner?.abort();
    this.contentEl.empty();
  }

  private showPrompt(error = ''): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      cls: 'agenthq-help',
      text: 'The agent sees only this text and a little around it, and nothing is changed until you accept.',
    });
    contentEl.createEl('pre', {
      cls: 'agenthq-inline-original',
      text: this.original,
    });
    const box = contentEl.createEl('textarea', {
      cls: 'agenthq-inline-instruction',
      attr: {
        placeholder: 'What should change? For example: make it shorter',
        rows: '3',
      },
    });
    box.value = this.instruction;
    box.addEventListener('input', () => {
      this.instruction = box.value;
    });
    new Setting(contentEl).setName('Agent').addDropdown((drop) => {
      for (const agent of this.agents) drop.addOption(agent.id, agent.name);
      drop.setValue(this.agentId).onChange((value) => {
        this.agentId = value;
      });
    });
    if (error) contentEl.createEl('p', { cls: 'agenthq-warning', text: error });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText('Edit')
          .setCta()
          .onClick(() => void this.run()),
      );
    box.focus();
  }

  private async run(): Promise<void> {
    const instruction = this.instruction.trim();
    if (!instruction || !this.agentId) {
      this.showPrompt('Say what should change first.');
      return;
    }
    this.remember(this.agentId);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'The agent is editing…' });
    this.runner = new AbortController();
    try {
      const result = await this.workspace.askOnce(
        this.agentId,
        inlineEditPrompt({
          instruction,
          selection: this.original,
          before: this.before,
          after: this.after,
        }),
        this.runner.signal,
      );
      if (this.runner.signal.aborted) return;
      if (result.isError || !result.text.trim()) {
        this.showPrompt(result.text || 'The agent did not return any text.');
        return;
      }
      this.showPreview(
        cleanReplacement(result.text, this.original),
        result.costUsd,
      );
    } catch (error) {
      if (this.runner.signal.aborted) return;
      this.showPrompt(
        error instanceof Error ? error.message : 'The edit failed.',
      );
    }
  }

  private showPreview(replacement: string, costUsd: number): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      cls: 'agenthq-help',
      text: `Preview, nothing is written yet. Cost $${costUsd.toFixed(4)}.`,
    });
    const parts = wordDiff(this.original, replacement);
    // Most of the text changed (a rewrite or a translation): Before and After read better than a diff full of marks.
    const shown: 'inline' | 'blocks' =
      this.layout || (isBigChange(parts) ? 'blocks' : 'inline');
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(
          shown === 'inline' ? 'Show before and after' : 'Show changes inline',
        )
        .onClick(() => {
          this.layout = shown === 'inline' ? 'blocks' : 'inline';
          this.rememberLayout(this.layout);
          this.showPreview(replacement, costUsd);
        }),
    );
    if (shown === 'blocks') {
      for (const [label, text] of [
        ['Before', this.original],
        ['After', replacement],
      ] as const) {
        contentEl.createDiv({ cls: 'agenthq-inline-label', text: label });
        contentEl.createDiv({ cls: 'agenthq-inline-block', text });
      }
    } else {
      const preview = contentEl.createDiv({ cls: 'agenthq-inline-diff' });
      for (const segment of groupChanges(parts)) {
        if (segment.type === 'same') {
          preview.createSpan({ text: segment.text });
          continue;
        }
        const phrase = preview.createSpan({ cls: 'agenthq-inline-change' });
        if (segment.del)
          phrase.createSpan({ cls: 'agenthq-inline-del', text: segment.del });
        if (segment.del && segment.add) phrase.appendText(' ');
        if (segment.add)
          phrase.createSpan({ cls: 'agenthq-inline-add', text: segment.add });
      }
    }
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Reject').onClick(() => this.close()),
      )
      .addButton((button) =>
        button.setButtonText('Try again').onClick(() => this.showPrompt()),
      )
      .addButton((button) =>
        button
          .setButtonText('Accept')
          .setCta()
          .onClick(() => this.accept(replacement)),
      );
  }

  private accept(replacement: string): void {
    // The note may have changed while the agent worked: only replace the text that was previewed.
    if (
      this.editor.getRange(this.target.from, this.target.to) !== this.original
    ) {
      new Notice(
        'The text changed while the agent worked, so nothing was replaced.',
      );
      this.close();
      return;
    }
    this.editor.replaceRange(replacement, this.target.from, this.target.to);
    this.close();
  }
}
