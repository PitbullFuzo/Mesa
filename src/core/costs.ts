import { readMessages } from './chat';
import { t } from './i18n';
import type { NoteDocument } from './notes';

/** One piece of spending that Mesa stored: when, which agent, and dollars or (for Codex) tokens. */
export interface SpendEvent {
  /** ISO time, or a plain YYYY-MM-DD date for delegated tasks. */
  at: string;
  agentId: string;
  costUsd?: number;
  tokens?: number;
}

export interface Spend {
  usd: number;
  tokens: number;
}

export interface AgentSpend extends Spend {
  agentId: string;
}

export interface CostSummary {
  today: Spend;
  last7Days: Spend;
  thisMonth: Spend;
  /** This month, biggest first. */
  agents: AgentSpend[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

/**
 * Spending from chat notes: every reply that reported a cost or tokens. Forked chats copy the earlier replies of the
 * chat they came from, so a reply seen twice (same agent, time and amount) is counted once.
 */
export function chatSpendEvents(notes: NoteDocument[]): SpendEvent[] {
  const seen = new Set<string>();
  const events: SpendEvent[] = [];
  for (const note of notes) {
    const fm = record(note.frontmatter);
    if (fm.agenthq !== 'chat' || typeof fm.agentId !== 'string') continue;
    for (const message of readMessages(note.body)) {
      if (message.role !== 'assistant') continue;
      const hasCost = typeof message.costUsd === 'number';
      const hasTokens = typeof message.tokens === 'number';
      if (!hasCost && !hasTokens) continue;
      const key = `${fm.agentId}|${message.timestamp}|${message.costUsd ?? ''}|${message.tokens ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        at: message.timestamp,
        agentId: fm.agentId,
        ...(hasCost ? { costUsd: message.costUsd } : {}),
        ...(hasTokens ? { tokens: message.tokens } : {}),
      });
    }
  }
  return events;
}

/**
 * Spending from delegated task notes. A task keeps only its totals, so it is dated by the day in its file name
 * ("2026-11-12 0930 Title - id"), and its worker and checker are charged separately. Tasks do not keep tokens.
 */
export function taskSpendEvents(notes: NoteDocument[]): SpendEvent[] {
  const events: SpendEvent[] = [];
  for (const note of notes) {
    const fm = record(note.frontmatter);
    if (fm.agenthq !== 'task') continue;
    const date = /^(\d{4}-\d{2}-\d{2}) /.exec(note.name)?.[1];
    if (!date) continue;
    for (const [field, agent] of [
      ['workerTotalCostUsd', fm.toId],
      ['verifierTotalCostUsd', fm.verifierId],
    ] as const) {
      const cost = fm[field];
      if (typeof cost === 'number' && cost > 0 && typeof agent === 'string')
        events.push({ at: date, agentId: agent, costUsd: cost });
    }
  }
  return events;
}

function eventTime(at: string): Date | null {
  // A plain date means that day on the local clock.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at);
  const time = plain
    ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]))
    : new Date(at);
  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * Totals for today, the last 7 days (today and the six days before) and this calendar month, on the local clock,
 * with this month's spend per agent. Dollars and tokens are kept apart: tokens are never turned into a price. A reply
 * that reported dollars counts as dollars only.
 */
export function costSummary(events: SpendEvent[], now: Date): CostSummary {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const today = new Date(y, m, d);
  const weekStart = new Date(y, m, d - 6);
  const monthStart = new Date(y, m, 1);
  const tomorrow = new Date(y, m, d + 1);
  const summary: CostSummary = {
    today: { usd: 0, tokens: 0 },
    last7Days: { usd: 0, tokens: 0 },
    thisMonth: { usd: 0, tokens: 0 },
    agents: [],
  };
  const perAgent = new Map<string, Spend>();
  for (const event of events) {
    const time = eventTime(event.at);
    if (!time || time >= tomorrow) continue;
    const usd = event.costUsd ?? 0;
    const tokens = event.costUsd === undefined ? (event.tokens ?? 0) : 0;
    const add = (spend: Spend) => {
      spend.usd += usd;
      spend.tokens += tokens;
    };
    if (time >= today) add(summary.today);
    if (time >= weekStart) add(summary.last7Days);
    if (time >= monthStart) {
      add(summary.thisMonth);
      const agent = perAgent.get(event.agentId) ?? { usd: 0, tokens: 0 };
      add(agent);
      perAgent.set(event.agentId, agent);
    }
  }
  summary.agents = [...perAgent]
    .map(([agentId, spend]) => ({ agentId, ...spend }))
    .sort(
      (a, b) =>
        b.usd - a.usd ||
        b.tokens - a.tokens ||
        a.agentId.localeCompare(b.agentId),
    );
  return summary;
}

/** "$0.42", "12,300 tokens", or "$0.42 + 12,300 tokens" when both were used. */
export function formatSpend(spend: Spend): string {
  const parts: string[] = [];
  if (spend.usd > 0 || spend.tokens === 0)
    parts.push(`$${spend.usd.toFixed(spend.usd >= 10 ? 2 : 4)}`);
  if (spend.tokens > 0)
    parts.push(
      t('costs.tokens', {
        n: Math.round(spend.tokens).toLocaleString('en-US'),
      }),
    );
  return parts.join(' + ');
}
