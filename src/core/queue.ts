interface Job {
  key: string;
  task: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (reason: unknown) => void;
  settled: Promise<void>;
  settle: () => void;
}

/** One shared queue; a key's jobs are serialized to protect its session. */
export class RunQueue {
  private pending: Job[] = [];
  private running = new Set<Job>();

  constructor(private readonly limit: () => number) {}

  snapshot(): { running: number; queued: number } {
    return { running: this.running.size, queued: this.pending.length };
  }

  private stopping = 0;
  private readonly stoppingKeys = new Map<string, number>();

  enqueue(key: string, task: Job['task']): Promise<void> {
    if (this.stopping || this.stoppingKeys.has(key))
      return Promise.reject(new Error('Queue is stopping'));
    return new Promise((resolve, reject) => {
      let settle!: () => void;
      const settled = new Promise<void>((done) => {
        settle = done;
      });
      this.pending.push({
        key,
        task,
        controller: new AbortController(),
        resolve,
        reject,
        settled,
        settle,
      });
      this.pump();
    });
  }

  async cancel(key?: string): Promise<void> {
    if (key === undefined) this.stopping++;
    else this.stoppingKeys.set(key, (this.stoppingKeys.get(key) ?? 0) + 1);
    try {
      const matches = (job: Job) => key === undefined || job.key === key;
      const cancelled = this.pending.filter(matches);
      this.pending = this.pending.filter((job) => !matches(job));
      for (const job of cancelled) {
        job.controller.abort();
        job.resolve();
        job.settle();
      }
      const running = [...this.running].filter(matches);
      for (const job of running) job.controller.abort();
      await Promise.all(running.map((job) => job.settled));
    } finally {
      if (key === undefined) this.stopping--;
      else {
        const remaining = (this.stoppingKeys.get(key) ?? 1) - 1;
        if (remaining) this.stoppingKeys.set(key, remaining);
        else this.stoppingKeys.delete(key);
      }
      this.pump();
    }
  }

  stopAll(): Promise<void> {
    return this.cancel();
  }

  private pump(): void {
    if (this.stopping) return;
    const maximum = Math.max(1, Math.floor(this.limit()) || 1);
    while (this.running.size < maximum) {
      const index = this.pending.findIndex(
        (job) => ![...this.running].some((active) => active.key === job.key),
      );
      if (index < 0) return;
      const job = this.pending.splice(index, 1)[0]!;
      this.running.add(job);
      void Promise.resolve()
        .then(() =>
          job.controller.signal.aborted
            ? undefined
            : job.task(job.controller.signal),
        )
        .then(
          () => this.finish(job),
          (error: unknown) => this.finish(job, error),
        );
    }
  }

  private finish(job: Job, error?: unknown): void {
    this.running.delete(job);
    if (error === undefined) job.resolve();
    else job.reject(error);
    job.settle();
    this.pump();
  }
}
