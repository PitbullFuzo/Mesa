import { expect, it } from 'vitest';
import { agentFrontmatterSchema } from '../src/core/model';
import { setupPatchSchema } from '../src/core/setup';
import { loadSettings } from '../src/core/settings';
import { MemoryStore } from '../src/core/memoryStore';
import { browserUnavailableReason } from '../src/core/browser';
it('defaults browser permission off, engine to Playwright, and persists explicit opt-in', async () => {
  const store = new MemoryStore();
  const id = await store.createAgent('Browser');
  const a = (await store.loadAgents()).agents[0]!;
  expect(agentFrontmatterSchema.parse(a).canUseBrowser).toBe(false);
  expect(loadSettings({}).browserEngine).toBe('playwright');
  await store.patchAgent(id, setupPatchSchema.parse({ canUseBrowser: true }));
  expect((await store.loadAgents()).agents[0]?.canUseBrowser).toBe(true);
});
it('allows every runtime that can load exactly Obi-I’s browser, and refuses the rest with a reason', () => {
  for (const runtime of ['claude-code', 'opencode', 'hermes'])
    expect(browserUnavailableReason(runtime, false, 'playwright')).toBe('');
  expect(browserUnavailableReason('codex', false, 'playwright')).toBe('');
  expect(browserUnavailableReason('claude-code', true, 'playwright')).toMatch(
    /whole-computer/,
  );
  expect(browserUnavailableReason('openrouter', false, 'playwright')).toMatch(
    /cannot load exactly/,
  );
  expect(browserUnavailableReason('hermes', false, 'hermes')).toMatch(
    /isolat|confine/,
  );
});
it('keeps refusing Codex whole-computer reads unless the browser tick box is also ticked', () => {
  expect(browserUnavailableReason('codex', true, 'playwright')).toMatch(/Tick/);
  expect(browserUnavailableReason('codex', true, 'playwright', true)).toBe('');
  // The extra tick never helps another runtime.
  expect(
    browserUnavailableReason('claude-code', true, 'playwright', true),
  ).toMatch(/whole-computer/);
  expect(browserUnavailableReason('codex', true, 'hermes', true)).toMatch(
    /Hermes browser/,
  );
});
