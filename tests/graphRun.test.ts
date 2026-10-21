import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { graphAiRefusal } from '../src/core/graphAi';
import { MemoryStore } from '../src/core/memoryStore';
import type { MemoryChoice } from '../src/core/projects';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { RuntimeAdapter } from '../src/core/runtimes/types';

/** A chat service whose only runtime is a scripted fake; `id` changes what the service thinks the runtime is. */
async function make(memoryModel: MemoryChoice, id?: string) {
  const store = new MemoryStore('Mesa');
  const fake = new FakeRuntime(
    () => [
      {
        type: 'done',
        text: '{"concepts":[],"related":[]}',
        isError: false,
        costUsd: 0.003,
      },
    ],
    0,
  );
  if (id) Object.defineProperty(fake, 'id', { value: id });
  const adapter: RuntimeAdapter = fake;
  const service = new ChatService({
    store,
    adapters: [adapter],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: [], memoryModel }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  return { service, fake };
}

describe('the graph AI run is confined', () => {
  it('runs in an empty scratch folder outside the vault, with no access beyond the prompt', async () => {
    const { service, fake } = await make('auto');
    const result = await service.graphConceptRun(
      'Only this note text.',
      new AbortController().signal,
    );
    expect(result).toMatchObject({ isError: false, costUsd: 0.003 });
    const request = fake.requests.at(-1)!;
    expect(request.prompt).toBe('Only this note text.');
    expect(request.systemPrompt).toBe('');
    expect(request.permission).toBe('read-only');
    expect(request.cwd).not.toBe('/vault');
    expect(request.cwd.startsWith(tmpdir())).toBe(true);
    expect(request.extraDirs).toEqual([]);
    expect(request.readDirs).toEqual([]);
    expect(request.protectedPaths).toEqual([]);
    expect(request.webAccess).toBe(false);
    expect(request.canUseBrowser).toBe(false);
    expect(request.runCommands).toBeUndefined();
    expect(request.askCommand).toBeUndefined();
    expect(request.wholeComputerReadConfirmed).toBe(false);
    // The scratch folder is removed after the call.
    expect(existsSync(request.cwd)).toBe(false);
  });

  it('refuses Codex with a plain reason and starts no run', async () => {
    const { service, fake } = await make('codex', 'codex');
    const result = await service.graphConceptRun(
      'Note text.',
      new AbortController().signal,
    );
    expect(result?.refused).toMatch(/Codex can read the whole computer/);
    expect(fake.requests).toHaveLength(0);
  });

  it('names Codex as the only refused runtime', () => {
    expect(graphAiRefusal('codex')).not.toBeNull();
    expect(graphAiRefusal('claude-code')).toBeNull();
    expect(graphAiRefusal('opencode')).toBeNull();
    expect(graphAiRefusal('hermes')).toBeNull();
  });
});
