/** How much of a model's context a conversation uses, as the runtime reported it after the last reply. */
export interface ContextUse {
  /** Tokens in the context after the last reply. */
  used: number;
  /** The model's context window, when the runtime reported it. */
  window?: number;
}

/** Above this share of the window the indicator suggests a new chat or a fork. */
export const CONTEXT_WARN = 0.8;

export interface ContextView {
  /** Short text for the bar: "23%", "41,000 tokens" or "unknown". */
  text: string;
  /** 0 to 1 when the window is known, else undefined (no bar). */
  fraction?: number;
  warn: boolean;
  tip: string;
}

export function contextView(use?: ContextUse): ContextView {
  if (!use || !(use.used >= 0))
    return {
      text: 'unknown',
      warn: false,
      tip: 'This runtime has not reported how much context is used yet.',
    };
  const tokens = `${Math.round(use.used).toLocaleString('en-US')} tokens`;
  if (!use.window)
    return {
      text: tokens,
      warn: false,
      tip: `${tokens} used. The model's window size is not reported.`,
    };
  const fraction = Math.min(1, use.used / use.window);
  const warn = fraction >= CONTEXT_WARN;
  return {
    text: `${Math.round(fraction * 100)}%`,
    fraction,
    warn,
    tip: `${tokens} of ${use.window.toLocaleString('en-US')} used.${warn ? ' Start a new chat or Fork to keep replies sharp.' : ''}`,
  };
}

/** One of the plan's usage windows (Claude Code): the share used, 0 to 1, and when it resets (epoch seconds). */
export interface PlanWindow {
  utilization: number;
  resetsAt: number;
}
export interface PlanUsage {
  fiveHour?: PlanWindow;
  sevenDay?: PlanWindow;
}

const percent = (window: PlanWindow) => Math.round(window.utilization * 100);

/** "5h 11% · week 42%", or an empty string when nothing was reported. */
export function planMeterText(usage?: PlanUsage): string {
  if (!usage) return '';
  return [
    usage.fiveHour ? `5h ${percent(usage.fiveHour)}%` : '',
    usage.sevenDay ? `week ${percent(usage.sevenDay)}%` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The reset times for the click-through, in the reader's time zone. */
export function planResetText(usage?: PlanUsage): string {
  if (!usage) return '';
  const at = (window: PlanWindow) =>
    new Date(window.resetsAt * 1000).toLocaleString();
  return [
    usage.fiveHour ? `5-hour window resets ${at(usage.fiveHour)}` : '',
    usage.sevenDay ? `Weekly window resets ${at(usage.sevenDay)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
