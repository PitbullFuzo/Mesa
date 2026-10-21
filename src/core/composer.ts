/** Keyboard rule for message boxes shared by Chat and the broadcast bar. */
export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}

/** Enter sends only when "Press Enter to send" is on, never on Shift+Enter or during IME composition. */
export function enterSendsMessage(
  event: ComposerKey,
  enterToSend: boolean,
): boolean {
  // Some engines report key code 229 while an IME owns the key instead of setting isComposing.
  return (
    enterToSend &&
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

/** A message needs text or at least one image; whitespace alone is nothing to send. */
export function hasSendableContent(text: string, imageCount: number): boolean {
  return text.trim().length > 0 || imageCount > 0;
}

/** The most characters of an attached note that go into one message. */
export const NOTE_ATTACH_LIMIT = 20_000;

/**
 * The text sent when the owner attached a note: the note first, marked as attached by the owner, then the message.
 * The agent gets it because the owner attached it, whatever its vault access is.
 */
export function withAttachedNote(
  text: string,
  note: { path: string; content: string; truncated: boolean },
): string {
  return `The owner attached this note (\`${note.path}\`)${note.truncated ? ', cut because it is long' : ''}:

${note.content}

---
${text}`;
}
