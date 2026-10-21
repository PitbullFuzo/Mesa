/* eslint obsidianmd/prefer-window-timers: off -- Pure core uses Node timers and must run without a browser window in automated tests. */
import type { RunEvent, RunRequest, RuntimeAdapter } from './types';

export type FakeScript = readonly RunEvent[];
export type FakeScripts =
  readonly FakeScript[] | ((request: RunRequest, index: number) => FakeScript);

export class FakeRuntime implements RuntimeAdapter {
  readonly id = 'fake';
  readonly displayName = 'Scripted test runtime';
  readonly requests: RunRequest[] = [];

  constructor(
    private readonly scripts: FakeScripts = [],
    private readonly delayMs = 20,
  ) {}

  detect() {
    return Promise.resolve({ available: true });
  }

  start(request: RunRequest, onEvent: (event: RunEvent) => void) {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const script =
      typeof this.scripts === 'function'
        ? this.scripts(request, index)
        : this.scripts[index];
    const reports =
      request.systemPrompt
        .split('## Your direct reports\n')[1]
        ?.split('\n\n')[0]
        ?.split('\n')
        .flatMap((line) => {
          const match = /^- (.+?) \(/.exec(line);
          return match ? [match[1]!] : [];
        }) ?? [];
    const demo = /^Developer verification (pass|exhaust|retry|stop) demo$/.exec(
      request.prompt.trim(),
    );
    const verifyDemo = request.prompt.startsWith('Verify task:')
      ? /\[Developer verification (pass|exhaust|retry|stop)\]/.exec(
          request.prompt,
        )
      : null;
    const attempt = Number(/\nAttempt: (\d+)/.exec(request.prompt)?.[1] ?? 1);
    const fallback =
      demo && reports.length >= 2
        ? 'Developer verification demo only; no real inference.\n```agenthq-delegate\n' +
          JSON.stringify({
            tasks: (demo[1] === 'stop'
              ? reports.slice(0, 2)
              : [reports.find((name) => name === 'Coder') ?? reports[0]!]
            ).map((to) => ({
              to,
              task: `[Developer verification ${demo[1]}] Reply with a short completion message.`,
              verifyWith:
                reports.find((name) => name === 'Reviewer') ?? reports.at(-1),
              maxAttempts: 3,
            })),
          }) +
          '\n```'
        : verifyDemo
          ? '```agenthq-verdict\n' +
            JSON.stringify({
              verdict:
                (verifyDemo[1] === 'pass' && attempt >= 3) ||
                (verifyDemo[1] === 'retry' && attempt >= 5)
                  ? 'pass'
                  : 'fail',
              feedback: `[Developer verification ${verifyDemo[1]}] ${attempt < 5 ? 'Please improve the answer.' : 'Review complete.'}`,
            }) +
            '\n```'
          : request.prompt.trim() === 'Developer delegation demo' &&
              reports.length
            ? 'Developer demo only; no real inference.\n```agenthq-delegate\n' +
              JSON.stringify({
                tasks: reports.slice(0, 2).map((to, index) => ({
                  to,
                  task: `Developer demo task ${index + 1}: reply with a short completion message.`,
                })),
              }) +
              '\n```'
            : 'Test reply: ' + request.prompt;
    const slow =
      !script && request.prompt.startsWith('[Developer verification stop]');
    const events = script ?? [
      ...(slow
        ? Array.from({ length: 120 }, () => ({
            type: 'text' as const,
            text: 'Working… ',
          }))
        : []),
      { type: 'text' as const, text: fallback },
      {
        type: 'done' as const,
        text: fallback,
        isError: false,
        costUsd: 0,
      },
    ];
    let text = '';
    let position = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (finished) return;
      const event = events[position++];
      if (!event) {
        finished = true;
        onEvent({ type: 'done', text: '', isError: false });
        return;
      }
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') finished = true;
      onEvent(structuredClone(event));
      if (!finished) timer = setTimeout(tick, slow ? 250 : this.delayMs);
    };
    timer = setTimeout(tick, this.delayMs);
    return {
      stop: () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          onEvent({
            type: 'done',
            text: text || 'Run stopped.',
            isError: true,
            errorKind: 'other',
          });
        }
        return Promise.resolve();
      },
    };
  }
}
