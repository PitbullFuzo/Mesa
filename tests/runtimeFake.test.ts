import { describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RunEvent, RunRequest } from '../src/core/runtimes/types';

const request: RunRequest = {
  prompt: 'hello',
  systemPrompt: '',
  cwd: '/work',
  sessionId: 'session',
  resume: false,
  permission: 'read-only',
};

describe('scripted runtime', () => {
  it('cancels once, preserving partial output and suppressing remaining callbacks', async () => {
    vi.useFakeTimers();
    try {
      const events: RunEvent[] = [];
      const runtime = new FakeRuntime(
        [
          [
            { type: 'text', text: 'partial' },
            { type: 'text', text: 'late' },
          ],
        ],
        10,
      );
      const run = runtime.start(request, (event) => events.push(event));
      await vi.advanceTimersByTimeAsync(10);
      await run.stop();
      await run.stop();
      await vi.runAllTimersAsync();
      expect(events).toEqual([
        { type: 'text', text: 'partial' },
        { type: 'done', text: 'partial', isError: true, errorKind: 'other' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('streams a supplied script asynchronously and records session requests', async () => {
    vi.useFakeTimers();
    try {
      const events: RunEvent[] = [];
      const runtime = new FakeRuntime(
        [
          [
            { type: 'text', text: 'hi' },
            { type: 'done', text: 'hi', isError: false },
          ],
        ],
        10,
      );
      expect((await runtime.detect()).available).toBe(true);
      runtime.start(request, (event) => events.push(event));
      expect(events).toEqual([]);
      await vi.runAllTimersAsync();
      expect(events.map((event) => event.type)).toEqual(['text', 'done']);
      expect(runtime.requests).toEqual([request]);
    } finally {
      vi.useRealTimers();
    }
  });
});
