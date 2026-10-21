import { describe, expect, it } from 'vitest';
import { RunQueue } from '../src/core/queue';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('RunQueue', () => {
  it('allows unrelated work while one key is being stopped', async () => {
    const queue = new RunQueue(() => 2);
    const cleanup = deferred();
    const first = queue.enqueue('a', async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            void cleanup.promise.then(resolve);
          },
          { once: true },
        ),
      );
    });
    await Promise.resolve();
    const stopping = queue.cancel('a');
    let started = false;
    const other = queue.enqueue('b', async () => {
      started = true;
    });
    const accepted = expect(other).resolves.toBeUndefined();
    await Promise.resolve();
    expect(started).toBe(true);
    cleanup.resolve();
    await Promise.all([first, stopping, accepted]);
  });
  it('cancels queued jobs and waits for running cleanup before stopAll returns', async () => {
    const queue = new RunQueue(() => 1);
    const cleanup = deferred();
    let starts = 0;
    const first = queue.enqueue('a', async (signal) => {
      starts++;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            void cleanup.promise.then(resolve);
          },
          { once: true },
        ),
      );
    });
    const second = queue.enqueue('b', async () => {
      starts++;
    });
    await Promise.resolve();
    let stopped = false;
    const stop = queue.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await Promise.all([stop, first, second]);
    expect(starts).toBe(1);
    expect(queue.snapshot()).toEqual({ running: 0, queued: 0 });
  });
  it('serializes same-key work and propagates failures without leaking a slot', async () => {
    const queue = new RunQueue(() => 2);
    const gate = deferred();
    const order: number[] = [];
    const one = queue.enqueue('a', async () => {
      order.push(1);
      await gate.promise;
    });
    const two = queue.enqueue('a', async () => {
      order.push(2);
      throw new Error('failed');
    });
    const failure = expect(two).rejects.toThrow('failed');
    await Promise.resolve();
    expect(order).toEqual([1]);
    gate.resolve();
    await one;
    await failure;
    expect(order).toEqual([1, 2]);
    expect(queue.snapshot().running).toBe(0);
  });
  it('runs five messages with at most two concurrent tasks', async () => {
    const queue = new RunQueue(() => 2);
    const gates = Array.from({ length: 5 }, deferred);
    let active = 0;
    let peak = 0;
    const runs = gates.map((gate, index) =>
      queue.enqueue(String(index), async () => {
        peak = Math.max(peak, ++active);
        await gate.promise;
        active--;
      }),
    );
    await Promise.resolve();
    expect(active).toBe(2);
    for (const gate of gates) {
      gate.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(queue.snapshot()).toEqual({ running: 0, queued: 0 });
  });
});
