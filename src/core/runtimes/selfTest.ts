/** One free self-test result for one CLI version, kept in data.json so it runs once per version. */
export interface SelfTestRecord {
  result: 'pass' | 'fail';
  detail: string;
  checkedAt: string;
}

/** Keyed by tool and version, for example "codex 0.163.0". */
export type SelfTestMemory = Record<string, SelfTestRecord>;

/**
 * What a self-test run found. "fail" is a real policy breach and is remembered. "unsupported" means the check
 * could not run to a result (offline, timeout, crash, no free check here): it is never remembered, so it is retried.
 */
export interface SelfTestOutcome {
  result: 'pass' | 'fail' | 'unsupported';
  detail: string;
}

/** What the Codex sandbox probes observed. */
export interface SandboxProbes {
  /** The network request, run without the sandbox, reached the internet. Without this the network result means nothing. */
  control: boolean;
  /** Every probe command started and printed its marker, so each result is real and not a crash or a timeout. */
  ran: boolean;
  insideWritten: boolean;
  outsideWritten: boolean;
  networkReached: boolean;
  output: string[];
}

/**
 * Passes only when the project folder is writable, and the outside write and the network are refused.
 * A missing control or a probe that did not run is "unsupported" (retry later), not a breach.
 * Output about unknown or renamed settings counts as a failure, because the sandbox cannot be trusted then.
 */
export function judgeSandboxProbes(probes: SandboxProbes): SelfTestOutcome {
  if (!probes.control)
    return {
      result: 'unsupported',
      detail: "Can't check now: no internet. Will retry.",
    };
  if (!probes.ran)
    return {
      result: 'unsupported',
      detail: 'The safety check did not finish. Will retry.',
    };
  if (!probes.insideWritten)
    return {
      result: 'fail',
      detail: 'the sandbox would not write inside the project folder',
    };
  if (probes.outsideWritten)
    return {
      result: 'fail',
      detail: 'the sandbox let a write outside the project folder through',
    };
  if (probes.networkReached)
    return {
      result: 'fail',
      detail: 'the sandbox let a network request through',
    };
  if (probes.output.some((text) => /unknown|unrecognized|warning/i.test(text)))
    return {
      result: 'fail',
      detail: 'the sandbox reported unknown or renamed settings',
    };
  return { result: 'pass', detail: 'all sandbox probes behaved as required' };
}

/**
 * Runs a self-test at most once per version, reuses the remembered result, and writes new results with `remember`.
 * Concurrent callers share the same run. Only pass and fail are remembered; an unsupported outcome, or a run that
 * throws, is returned to the caller and tried again later.
 */
export async function selfTestOnce(
  key: string,
  memory: SelfTestMemory,
  remember: (key: string, record: SelfTestRecord) => void,
  pending: Map<string, Promise<SelfTestOutcome>>,
  run: () => Promise<SelfTestOutcome>,
): Promise<SelfTestOutcome> {
  const known = memory[key];
  if (known) return { result: known.result, detail: known.detail };
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const started = (async (): Promise<SelfTestOutcome> => {
    let outcome: SelfTestOutcome;
    try {
      outcome = await run();
    } catch {
      outcome = {
        result: 'unsupported',
        detail: 'The safety check did not finish. Will retry.',
      };
    }
    if (outcome.result !== 'unsupported')
      remember(key, {
        result: outcome.result,
        detail: outcome.detail,
        checkedAt: new Date().toISOString(),
      });
    return outcome;
  })();
  pending.set(key, started);
  try {
    return await started;
  } finally {
    pending.delete(key);
  }
}

/** Forgets every stored safety result, so the next detection runs the check again ("Re-run safety check"). */
export function clearSafetyChecks(memory: SelfTestMemory): number {
  const keys = Object.keys(memory);
  for (const key of keys) delete memory[key];
  return keys.length;
}
