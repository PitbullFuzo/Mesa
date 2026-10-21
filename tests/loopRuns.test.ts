import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';

const paid = (text: string, costUsd = 0) => [
  { type: 'done' as const, text, isError: false, costUsd },
];
const verdict = (value: 'pass' | 'fail') =>
  '```agenthq-verdict\n' +
  JSON.stringify({ verdict: value, feedback: 'Tighten it.' }) +
  '\n```';

/** Coder and reviewer on the fake runtime. The reviewer's verdicts come from the list, in order. */
async function setup(verdicts: ('pass' | 'fail')[], costUsd = 0, delayMs = 0) {
  const store = new MemoryStore('Obi-I');
  const coder = await store.createAgent('Coder');
  const reviewer = await store.createAgent('Reviewer');
  for (const id of [coder, reviewer])
    await store.patchAgent(id, { runtime: 'fake' });
  const pending = [...verdicts];
  const runtime = new FakeRuntime((request) => {
    if (request.prompt.startsWith('Judge the reply'))
      return paid(verdict(pending.shift() ?? 'fail'), costUsd);
    return paid('draft', costUsd);
  }, delayMs);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  return { store, service, runtime, coder, reviewer };
}

describe('loop runs with the fake runtime', () => {
  it('repeats until the reviewer passes, then stops and logs the outcome', async () => {
    const { store, service, runtime, coder, reviewer } = await setup([
      'fail',
      'pass',
    ]);
    const result = await service.startLoop(
      coder,
      { kind: 'until-pass', verifierId: reviewer, rounds: 5 },
      'Write the summary',
    );
    expect(result.status).toBe('passed');
    expect(result.rounds).toBe(2);
    const coderTurns = runtime.requests.filter(
      (request) => !request.prompt.startsWith('Judge the reply'),
    );
    const reviewerTurns = runtime.requests.filter((request) =>
      request.prompt.startsWith('Judge the reply'),
    );
    expect(coderTurns).toHaveLength(2);
    expect(reviewerTurns).toHaveLength(2);
    expect(coderTurns[1]!.prompt).toContain('Tighten it.');
    const activity = (await store.loadActivity())
      .map((note) => note.body)
      .join('\n');
    expect(activity).toContain('Loop passed the reviewer after 2 rounds');
  });

  it('runs the given number of times without a reviewer', async () => {
    const { service, runtime, coder } = await setup([]);
    const result = await service.startLoop(
      coder,
      { kind: 'times', rounds: 3 },
      'Again',
    );
    expect(result).toMatchObject({ status: 'completed', rounds: 3 });
    expect(runtime.requests).toHaveLength(3);
    expect(
      runtime.requests.every((request) => request.prompt === 'Again'),
    ).toBe(true);
  });

  it('stops at the round limit when the reviewer never passes', async () => {
    const { service, runtime, coder, reviewer } = await setup(['fail', 'fail']);
    const result = await service.startLoop(
      coder,
      { kind: 'until-pass', verifierId: reviewer, rounds: 2 },
      'Write it',
    );
    expect(result).toMatchObject({ status: 'rounds-exhausted', rounds: 2 });
    expect(
      runtime.requests.filter(
        (request) => !request.prompt.startsWith('Judge the reply'),
      ),
    ).toHaveLength(2);
  });

  it('stops when the cost cap is reached', async () => {
    const { service, runtime, coder } = await setup([], 0.3);
    const result = await service.startLoop(
      coder,
      { kind: 'times', rounds: 10, costCapUsd: 0.5 },
      'Again',
    );
    expect(result).toMatchObject({ status: 'cost-limit', rounds: 2 });
    expect(runtime.requests).toHaveLength(2);
  });

  it('stops a running loop: the round in progress ends and no further round starts', async () => {
    const { service, runtime, coder } = await setup([], 0, 30);
    const running = service.startLoop(
      coder,
      { kind: 'times', rounds: 10 },
      'Again',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.stop(coder);
    const result = await running;
    expect(result.status).toBe('stopped');
    expect(runtime.requests.length).toBeLessThan(10);
  });

  it('lets only one loop run per agent at a time', async () => {
    const { service, coder } = await setup([]);
    const first = service.startLoop(
      coder,
      { kind: 'times', rounds: 2 },
      'Again',
    );
    await expect(
      service.startLoop(coder, { kind: 'times', rounds: 2 }, 'Again'),
    ).rejects.toThrow('already has a loop running');
    await first;
  });
});
