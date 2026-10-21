import { parseVerdict } from './protocol';

export const LOOP_DEFAULT_ROUNDS = 5;
export const LOOP_MAX_ROUNDS = 20;
const CRITERION = 'The reply fully completes the request.';

/** One loop, chosen in the 🔁 menu. Judging loops need a reviewer; "times" only repeats the message. */
export type LoopSpec =
  | {
      kind: 'until-pass';
      verifierId: string;
      rounds: number;
      costCapUsd?: number;
    }
  | {
      kind: 'until-condition';
      verifierId: string;
      condition: string;
      rounds: number;
      costCapUsd?: number;
    }
  | { kind: 'times'; rounds: number; costCapUsd?: number };

export type LoopStatus =
  | 'passed'
  | 'rounds-exhausted'
  | 'completed'
  | 'cost-limit'
  | 'project-limit'
  | 'stopped'
  | 'error';

export interface LoopResult {
  status: LoopStatus;
  rounds: number;
  costUsd: number;
}

/** What a loop asks of the chat: one agent turn, or one reviewer turn. null means the loop was stopped. */
export interface LoopTurn {
  text: string;
  costUsd: number;
  failed: boolean;
  /** The project cost limit refused this turn before it started. */
  limit?: boolean;
}
export interface LoopRunner {
  run(prompt: string, round: number): Promise<LoopTurn | null>;
  judge(prompt: string, round: number): Promise<LoopTurn | null>;
  progress(round: number, rounds: number): void;
  stopped(): boolean;
}

export function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return LOOP_DEFAULT_ROUNDS;
  return Math.min(LOOP_MAX_ROUNDS, Math.max(1, Math.floor(value)));
}

export function judgePrompt(criterion: string, reply: string): string {
  return [
    'Judge the reply below against this criterion. Do not use tools.',
    `Criterion: ${criterion}`,
    'End with exactly one agenthq-verdict block containing verdict (pass or fail) and feedback.',
    '',
    'Reply to judge:',
    reply,
  ].join('\n');
}

/**
 * Runs a loop. Hard stops: the round limit, the optional cost cap, and stop. A judging loop passes when the
 * reviewer returns a pass verdict; otherwise the reviewer's feedback is sent back to the agent.
 */
export async function runLoop(
  spec: LoopSpec,
  message: string,
  runner: LoopRunner,
): Promise<LoopResult> {
  const rounds = clampRounds(spec.rounds);
  const criterion =
    spec.kind === 'until-condition' ? spec.condition : CRITERION;
  let spent = 0;
  let prompt = message;
  for (let round = 1; round <= rounds; round++) {
    if (runner.stopped())
      return { status: 'stopped', rounds: round - 1, costUsd: spent };
    if (spec.costCapUsd !== undefined && spent >= spec.costCapUsd)
      return { status: 'cost-limit', rounds: round - 1, costUsd: spent };
    runner.progress(round, rounds);
    const reply = await runner.run(prompt, round);
    if (reply?.limit)
      return { status: 'project-limit', rounds: round - 1, costUsd: spent };
    if (!reply) return { status: 'stopped', rounds: round - 1, costUsd: spent };
    spent += reply.costUsd;
    if (reply.failed) return { status: 'error', rounds: round, costUsd: spent };
    if (spec.kind === 'times') {
      prompt = message;
      continue;
    }
    if (runner.stopped())
      return { status: 'stopped', rounds: round, costUsd: spent };
    const judged = await runner.judge(
      judgePrompt(criterion, reply.text),
      round,
    );
    if (judged?.limit)
      return { status: 'project-limit', rounds: round, costUsd: spent };
    if (!judged) return { status: 'stopped', rounds: round, costUsd: spent };
    spent += judged.costUsd;
    if (judged.failed)
      return { status: 'error', rounds: round, costUsd: spent };
    const verdict = parseVerdict(judged.text);
    if (verdict.verdict === 'pass')
      return { status: 'passed', rounds: round, costUsd: spent };
    prompt = `Verifier feedback:\n${verdict.feedback}\n\nRevise your answer to the original request:\n${message}`;
  }
  return {
    status: spec.kind === 'times' ? 'completed' : 'rounds-exhausted',
    rounds,
    costUsd: spent,
  };
}

/** The one-line summary shown when a loop ends and written to Activity. */
export function loopSummary(result: LoopResult): string {
  const label: Record<LoopStatus, string> = {
    passed: 'passed the reviewer',
    'rounds-exhausted': 'reached the round limit',
    completed: 'finished all runs',
    'cost-limit': 'reached its cost cap',
    'project-limit': 'stopped: project cost limit reached',
    stopped: 'was stopped',
    error: 'stopped on an error',
  };
  return `Loop ${label[result.status]} after ${result.rounds} round${result.rounds === 1 ? '' : 's'}, cost $${result.costUsd.toFixed(4)}`;
}
