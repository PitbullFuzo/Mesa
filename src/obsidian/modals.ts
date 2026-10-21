import { FuzzySuggestModal, Modal, Setting, type App } from 'obsidian';
import type { Agent } from '../core/model';

export function pickAgent(
  app: App,
  agents: Agent[],
  submit: (agent: Agent) => Promise<void>,
  reportError: (error: unknown) => void,
): void {
  class AgentPicker extends FuzzySuggestModal<Agent> {
    getItems(): Agent[] {
      return agents;
    }
    getItemText(agent: Agent): string {
      return `${agent.name} — ${agent.role || 'Agent'}`;
    }
    onChooseItem(agent: Agent): void {
      void submit(agent).catch(reportError);
    }
  }
  const picker = new AgentPicker(app);
  picker.setPlaceholder('Choose an agent for this note…');
  picker.open();
}

export function confirmAction(
  app: App,
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    class Confirmation extends Modal {
      private settled = false;
      onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl('p', { text: message, cls: 'agenthq-danger' });
        new Setting(this.contentEl)
          .addButton((button) =>
            button.setButtonText('Cancel').onClick(() => this.close()),
          )
          .addButton((button) =>
            button
              .setButtonText('Confirm')
              .setClass('mod-warning')
              .onClick(() => {
                this.settled = true;
                resolve(true);
                this.close();
              }),
          );
      }
      onClose(): void {
        if (!this.settled) resolve(false);
      }
    }
    new Confirmation(app).open();
  });
}

export function promptForName(
  app: App,
  title: string,
  submit: (name: string, color: string) => Promise<void>,
  reportError: (error: unknown) => void,
  withColor = false,
  actionLabel = 'Create',
  initial = '',
): void {
  class NamePrompt extends Modal {
    onOpen(): void {
      this.setTitle(title);
      let name = initial;
      let color = '#7c3aed';
      let busy = false;
      new Setting(this.contentEl).setName('Name').addText((text) => {
        text.inputEl.setAttribute('aria-label', 'Name');
        text.setValue(initial);
        text.onChange((value) => {
          name = value;
        });
        text.inputEl.focus();
      });
      if (withColor)
        new Setting(this.contentEl).setName('Color').addColorPicker((picker) =>
          picker.setValue(color).onChange((value) => {
            color = value;
          }),
        );
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText('Cancel').onClick(() => this.close()),
        )
        .addButton((button) =>
          button
            .setButtonText(actionLabel)
            .setCta()
            .onClick(async () => {
              if (busy) return;
              busy = true;
              button.setDisabled(true);
              try {
                await submit(name, color);
                this.close();
              } catch (error) {
                reportError(error);
              } finally {
                busy = false;
                button.setDisabled(false);
              }
            }),
        );
    }
  }
  new NamePrompt(app).open();
}
