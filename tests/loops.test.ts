import { describe, expect, it } from 'vitest';
import {
  clampRounds,
  loopSummary,
  runLoop,
  type LoopRunner,
  type LoopTurn,
} from '../src/core/loops';

const verdict = (verdictValue: 'pass' | 'fail', feedback = 'Fix it.') =>
  '```agenthq-verdict\n' +
  JSON.stringify({ verdict: verdictValue, feedback }) +
  '\n```';

/** A scripted runner: agent replies and reviewer verdicts come from queues; stop can be triggered. */
function scripted(options: {
  replies?: number;
  verdicts?: string[];
  cost?: number;
  stopAfterRuns?: number;
  failRun?: boolean;
}) {
  const prompts: string[] = [];
  const judged: string[] = [];
  let runs = 0;
  let stop = false;
  const turn = (text: string, cost: number, failed = false): LoopTurn => ({
    text,
    costUsd: cost,
    failed,
  });
  const runner: LoopRunner = {
    run(prompt) {
      if (stop) return Promise.resolve(null);
      prompts.push(prompt);
      runs++;
      if (options.stopAfterRuns !== undefined && runs >= options.stopAfterRuns)
        stop = true;
      return Promise.resolve(
        turn(`draft ${runs}`, options.cost ?? 0, options.failRun === true),
      );
    },
    judge(prompt) {
      if (stop) return Promise.resolve(null);
      judged.push(prompt);
      return Promise.resolve(
        turn(options.verdicts?.shift() ?? verdict('fail'), options.cost ?? 0),
      );
    },
    progress() {},
    stopped: () => stop,
  };
  return { runner, prompts, judged, runs: () => runs };
}

describe('loops: until the reviewer passes', () => {
  it('runs until a pass, sending the reviewer feedback back to the agent', async () => {
    const { runner, prompts, judged } = scripted({
      verdicts: [
        verdict('fail', 'Add tests.'),
        verdict('fail', 'Add docs.'),
        verdict('pass'),
      ],
    });
    const result = await runLoop(
      { kind: 'until-pass', verifierId: 'reviewer', rounds: 5 },
      'Write it',
      runner,
    );
    expect(result).toEqual({ status: 'passed', rounds: 3, costUsd: 0 });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('Add tests.');
    expect(prompts[2]).toContain('Add docs.');
    expect(judged).toHaveLength(3);
  });

  it('stops at the round limit when the reviewer never passes', async () => {
    const { runner, runs } = scripted({ verdicts: [] });
    const result = await runLoop(
      { kind: 'until-pass', verifierId: 'reviewer', rounds: 2 },
      'Write it',
      runner,
    );
    expect(result).toEqual({
      status: 'rounds-exhausted',
      rounds: 2,
      costUsd: 0,
    });
    expect(runs()).toBe(2);
  });

  it('judges the owner condition when it is given', async () => {
    const { runner, judged } = scripted({ verdicts: [verdict('pass')] });
    await runLoop(
      {
        kind: 'until-condition',
        verifierId: 'reviewer',
        condition: 'The list has five items.',
        rounds: 3,
      },
      'List things',
      runner,
    );
    expect(judged[0]).toContain('Criterion: The list has five items.');
  });
});

describe('loops: run N times', () => {
  it('repeats the same message the given number of times without a reviewer', async () => {
    const { runner, prompts, judged, runs } = scripted({});
    const result = await runLoop({ kind: 'times', rounds: 3 }, 'Again', runner);
    expect(result).toEqual({ status: 'completed', rounds: 3, costUsd: 0 });
    expect(runs()).toBe(3);
    expect(prompts).toEqual(['Again', 'Again', 'Again']);
    expect(judged).toHaveLength(0);
  });
});

describe('loops: hard stops', () => {
  it('stops when the cost cap is reached', async () => {
    const { runner, runs } = scripted({ cost: 0.4 });
    const result = await runLoop(
      { kind: 'times', rounds: 10, costCapUsd: 0.7 },
      'Again',
      runner,
    );
    expect(result).toEqual({ status: 'cost-limit', rounds: 2, costUsd: 0.8 });
    expect(runs()).toBe(2);
  });

  it('stops when the user stops the loop, and reports the rounds finished', async () => {
    const { runner, runs } = scripted({ stopAfterRuns: 2 });
    const result = await runLoop({ kind: 'times', rounds: 5 }, 'Again', runner);
    expect(result.status).toBe('stopped');
    expect(runs()).toBe(2);
  });

  it('stops with an error when an agent turn fails', async () => {
    const { runner } = scripted({ failRun: true });
    const result = await runLoop({ kind: 'times', rounds: 5 }, 'Again', runner);
    expect(result.status).toBe('error');
  });

  it('caps the number of rounds at 20 and defaults invalid input to 5', () => {
    expect(clampRounds(50)).toBe(20);
    expect(clampRounds(0)).toBe(1);
    expect(clampRounds(Number.NaN)).toBe(5);
    expect(clampRounds(3.7)).toBe(3);
  });

  it('describes the outcome in one line', () => {
    expect(loopSummary({ status: 'passed', rounds: 1, costUsd: 0.0123 })).toBe(
      'Loop passed the reviewer after 1 round, cost $0.0123',
    );
  });
});
