import { describe, expect, it } from 'vitest';
import { isAtBottom } from '../src/core/scroll';

describe('chat auto-scroll', () => {
  it('follows only when the reader is at or near the bottom', () => {
    expect(
      isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(true);
    expect(
      isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(true);
    expect(
      isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(false);
  });

  it('treats a short, non-scrolling message list as being at the bottom', () => {
    expect(
      isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 }),
    ).toBe(true);
  });
});

describe('opening a chat', () => {
  it('jumps straight to the newest message', async () => {
    const { scrollToLatest } = await import('../src/core/scroll');
    const panel = { scrollTop: 0, scrollHeight: 4000 };
    scrollToLatest(panel);
    expect(panel.scrollTop).toBe(4000);
  });
});
