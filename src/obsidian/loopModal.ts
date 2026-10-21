import {
  Modal,
  Notice,
  Setting,
  type App,
  type ButtonComponent,
} from 'obsidian';
import {
  LOOP_DEFAULT_ROUNDS,
  LOOP_MAX_ROUNDS,
  loopSummary,
  type LoopSpec,
} from '../core/loops';
import type { WorkspaceActions } from '../core/workspace';

type LoopKind = LoopSpec['kind'];

const TITLES: Record<LoopKind, string> = {
  'until-pass': 'Repeat until the reviewer passes',
  'until-condition': 'Repeat until…',
  times: 'Run N times',
};

/**
 * The form for one 🔁 loop. The message starts as the composer's draft and can be edited here. Starting
 * closes the form and the loop runs in the background; its outcome is shown as a notice and written to Activity.
 */
export function openLoopForm(
  app: App,
  workspace: WorkspaceActions,
  options: {
    agentId: string;
    kind: LoopKind;
    message: string;
    projectId?: string;
    onStarted: () => void;
  },
): void {
  class LoopForm extends Modal {
    onOpen(): void {
      const snapshot = workspace.getSnapshot();
      const agent = snapshot.agents.find(
        (entry) => entry.id === options.agentId,
      );
      const reviewers = snapshot.agents.filter(
        (entry) => entry.id !== options.agentId,
      );
      const judging = options.kind !== 'times';
      this.setTitle(TITLES[options.kind]);
      const draft = {
        message: options.message,
        reviewer:
          reviewers.find((entry) => entry.id === agent?.verifier)?.id ??
          reviewers[0]?.id ??
          '',
        condition: '',
        rounds: String(judging ? LOOP_DEFAULT_ROUNDS : 3),
        cap: '',
      };
      let startButton: ButtonComponent | null = null;
      new Setting(this.contentEl)
        .setName('Message')
        .setDesc(
          'Sent to the agent in every round. Starts from the chat draft.',
        )
        .addTextArea((area) => {
          area.setValue(draft.message).onChange((value) => {
            draft.message = value;
            startButton?.setDisabled(!value.trim());
          });
          area.inputEl.rows = 4;
        });
      if (judging)
        new Setting(this.contentEl).setName('Reviewer').addDropdown((drop) => {
          for (const reviewer of reviewers)
            drop.addOption(reviewer.id, reviewer.name);
          drop
            .setValue(draft.reviewer)
            .onChange((value) => (draft.reviewer = value));
        });
      if (options.kind === 'until-condition')
        new Setting(this.contentEl)
          .setName('Condition')
          .setDesc(
            'The reviewer judges each reply against this, in your words.',
          )
          .addTextArea((area) => {
            area
              .setValue(draft.condition)
              .onChange((value) => (draft.condition = value));
            area.inputEl.rows = 3;
          });
      new Setting(this.contentEl)
        .setName(options.kind === 'times' ? 'Runs' : 'Maximum rounds')
        .setDesc(`A whole number from 1 to ${LOOP_MAX_ROUNDS}.`)
        .addText((text) =>
          text
            .setValue(draft.rounds)
            .onChange((value) => (draft.rounds = value)),
        );
      new Setting(this.contentEl)
        .setName('Cost cap, USD (optional)')
        .setDesc('The loop stops once its spend reaches this.')
        .addText((text) =>
          text.setValue(draft.cap).onChange((value) => (draft.cap = value)),
        );
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) => {
          startButton = button;
          button
            .setButtonText('Start')
            .setCta()
            .setDisabled(!draft.message.trim())
            .onClick(() => {
              const rounds = Number(draft.rounds);
              const cap = draft.cap.trim() ? Number(draft.cap) : undefined;
              if (
                !Number.isInteger(rounds) ||
                rounds < 1 ||
                rounds > LOOP_MAX_ROUNDS
              ) {
                new Notice(
                  `Use a whole number of rounds from 1 to ${LOOP_MAX_ROUNDS}.`,
                );
                return;
              }
              if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) {
                new Notice('The cost cap must be a positive number.');
                return;
              }
              if (judging && !draft.reviewer) {
                new Notice('Pick a reviewer.');
                return;
              }
              if (
                options.kind === 'until-condition' &&
                !draft.condition.trim()
              ) {
                new Notice('Write the condition.');
                return;
              }
              const spec: LoopSpec =
                options.kind === 'times'
                  ? { kind: 'times', rounds, costCapUsd: cap }
                  : options.kind === 'until-condition'
                    ? {
                        kind: 'until-condition',
                        verifierId: draft.reviewer,
                        condition: draft.condition.trim(),
                        rounds,
                        costCapUsd: cap,
                      }
                    : {
                        kind: 'until-pass',
                        verifierId: draft.reviewer,
                        rounds,
                        costCapUsd: cap,
                      };
              this.close();
              options.onStarted();
              void workspace
                .startLoop(
                  options.agentId,
                  spec,
                  draft.message,
                  options.projectId,
                )
                .then(
                  (result) => {
                    new Notice(loopSummary(result));
                  },
                  (error: unknown) => {
                    workspace.reportError(error);
                  },
                );
            });
        });
    }
    onClose(): void {
      this.contentEl.empty();
    }
  }
  new LoopForm(app).open();
}
