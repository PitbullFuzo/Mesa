import { expect, it, vi } from 'vitest';
import { createRuntimeAdapters } from '../src/core/runtimes/registry';
import { ClaudeCodeRuntime } from '../src/core/runtimes/claudeCode';
import { FakeRuntime } from '../src/core/runtimes/fake';

it('registers the real runtime and exposes scripted testing only in developer mode', async () => {
  const options = {
    runtimePathOverride: '',
    vaultBasePath: 'C:/vault',
    managedRoot: 'Obi-I',
    developerMode: false,
  };
  const adapters = createRuntimeAdapters(options);
  expect(adapters).toHaveLength(4);
  expect(adapters[3]?.id).toBe('codex');
  expect(adapters[2]?.id).toBe('opencode');
  expect(adapters[1]?.id).toBe('hermes');
  expect(adapters[0]).toBeInstanceOf(ClaudeCodeRuntime);
  expect(
    createRuntimeAdapters({ ...options, developerMode: true }).some(
      (adapter) => adapter instanceof FakeRuntime,
    ),
  ).toBe(true);
  // Confirm the registry guard participates in the real launch, without an AI process.
  const adapter = adapters[0] as ClaudeCodeRuntime;
  const detector = vi
    .spyOn(adapter, 'detect')
    .mockResolvedValue({ available: false, hint: 'not installed' });
  const events: unknown[] = [];
  adapter.start(
    {
      prompt: '',
      systemPrompt: '',
      sessionId: 'a05d12f5-5b75-4b92-8296-9c43288d8182',
      resume: false,
      cwd: 'C:/vault/Notes',
      permission: 'read-only',
    },
    (event) => events.push(event),
  );
  await vi.waitFor(() => expect(events).toHaveLength(1));
  expect(detector).toHaveBeenCalledOnce(); // No "protected folders not configured" early refusal.
});

it.each([
  '../Other',
  '/absolute',
  'C:/absolute',
  '.obsidian',
  'Root/../Escape',
])('rejects an unsafe managed root %s', (managedRoot) => {
  expect(() =>
    createRuntimeAdapters({
      vaultBasePath: 'C:/vault',
      managedRoot,
      developerMode: false,
    }),
  ).toThrow();
});
