import { describe, expect, it } from 'vitest';
import { enterSendsMessage, hasSendableContent } from '../src/core/composer';

const key = (
  overrides: Partial<Parameters<typeof enterSendsMessage>[0]> = {},
) => ({
  key: 'Enter',
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe('Press Enter to send', () => {
  it('sends on plain Enter when the setting is on', () => {
    expect(enterSendsMessage(key(), true)).toBe(true);
  });

  it('keeps Shift+Enter as a new line when the setting is on', () => {
    expect(enterSendsMessage(key({ shiftKey: true }), true)).toBe(false);
  });

  it('inserts a new line on Enter when the setting is off', () => {
    expect(enterSendsMessage(key(), false)).toBe(false);
  });

  it('never sends while an IME composition is active', () => {
    expect(enterSendsMessage(key({ isComposing: true }), true)).toBe(false);
    expect(enterSendsMessage(key({ keyCode: 229 }), true)).toBe(false);
  });

  it('ignores other keys', () => {
    expect(enterSendsMessage(key({ key: 'a' }), true)).toBe(false);
  });
});

describe('sendable content', () => {
  it('refuses empty or whitespace-only messages without images', () => {
    expect(hasSendableContent('', 0)).toBe(false);
    expect(hasSendableContent('  \n\t ', 0)).toBe(false);
  });

  it('accepts text, or an image with no text', () => {
    expect(hasSendableContent('hello', 0)).toBe(true);
    expect(hasSendableContent('   ', 1)).toBe(true);
  });
});
