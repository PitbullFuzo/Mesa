import { Modal, Notice, Setting, type App } from 'obsidian';
import type { DeviceCode } from '../core/m365/auth';

/**
 * The Microsoft sign-in window: the code in large text, a Copy button, a button that opens Microsoft's page (from the
 * click itself, so it is not blocked), the plain address, and a live status. Closing it cancels the sign-in.
 */
export class M365SignInModal extends Modal {
  private status: HTMLElement | null = null;
  private cancel: HTMLButtonElement | null = null;
  private text = 'Waiting for you to approve…';

  constructor(
    app: App,
    private readonly code: DeviceCode,
    private readonly onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Sign in to Microsoft');
    const { contentEl } = this;
    contentEl.createEl('p', {
      text: 'Open Microsoft’s page and type this code there. Mesa never sees your password.',
    });
    contentEl.createDiv({
      cls: 'agenthq-signin-code',
      text: this.code.userCode,
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText('Copy code').onClick(() => {
          void navigator.clipboard
            .writeText(this.code.userCode)
            .then(() => new Notice('Code copied.'));
        }),
      )
      .addButton((button) =>
        button
          .setButtonText('Open Microsoft page')
          .setCta()
          .onClick(() => {
            window.open(this.code.verificationUri);
          }),
      );
    contentEl.createEl('p', {
      cls: 'agenthq-signin-url',
      text: this.code.verificationUri,
    });
    this.status = contentEl.createEl('p', { text: this.text });
    new Setting(contentEl).addButton((button) => {
      this.cancel = button.buttonEl;
      button.setButtonText('Cancel').onClick(() => this.close());
    });
  }

  /** Shows progress, the result or the error; `done` turns Cancel into Close. */
  setStatus(text: string, done = false): void {
    this.text = text;
    this.status?.setText(text);
    if (done) this.cancel?.setText('Close');
  }

  onClose(): void {
    this.onCancel();
    this.contentEl.empty();
  }
}
