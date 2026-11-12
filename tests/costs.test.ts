import { describe, expect, it } from 'vitest';
import {
  chatSpendEvents,
  costSummary,
  formatSpend,
  taskSpendEvents,
} from '../src/core/costs';
import type { NoteDocument } from '../src/core/notes';

function message(
  role: 'user' | 'assistant',
  timestamp: string,
  extra: { costUsd?: number; tokens?: number } = {},
) {
  const content = 'hi';
  const metadata = JSON.stringify({
    role,
    timestamp,
    tools: [],
    ...extra,
    contentLength: content.length,
    tailLength: 0,
  });
  return `<!-- agenthq-message ${metadata} -->\n### x\n\n${content}`;
}

function chat(agentId: string, messages: string[]): NoteDocument {
  return {
    path: `Mesa/Chats/${agentId}.md`,
    name: agentId,
    frontmatter: { agenthq: 'chat', agentId },
    body: messages.join('\n\n'),
  };
}

// 12 November 2026 is a Thursday; local midday so no time zone shifts the day.
const now = new Date(2026, 10, 12, 12, 0);
const at = (day: number, hour = 9) =>
  new Date(2026, 10, day, hour, 0).toISOString();

describe('costs', () => {
  it('adds up today, the last 7 days and this month, per agent', () => {
    const events = chatSpendEvents([
      chat('coder', [
        message('user', at(12)),
        message('assistant', at(12), { costUsd: 0.5 }),
        message('assistant', at(8), { costUsd: 0.25 }),
        message('assistant', at(5), { costUsd: 1 }),
      ]),
      chat('writer', [message('assistant', at(12, 10), { costUsd: 0.125 })]),
    ]);
    const summary = costSummary(events, now);
    expect(summary.today.usd).toBeCloseTo(0.625);
    expect(summary.last7Days.usd).toBeCloseTo(0.875); // 6th to 12th
    expect(summary.thisMonth.usd).toBeCloseTo(1.875);
    expect(summary.agents.map((a) => a.agentId)).toEqual(['coder', 'writer']);
    expect(summary.agents[0]!.usd).toBeCloseTo(1.75);
  });

  it('ignores last month and future times', () => {
    const summary = costSummary(
      [
        {
          at: new Date(2026, 9, 31, 23).toISOString(),
          agentId: 'a',
          costUsd: 5,
        },
        { at: new Date(2026, 10, 20).toISOString(), agentId: 'a', costUsd: 7 },
        { at: 'not a date', agentId: 'a', costUsd: 9 },
      ],
      now,
    );
    expect(summary.thisMonth.usd).toBe(0);
    expect(summary.agents).toEqual([]);
  });

  it('keeps tokens apart from dollars and never turns them into a price', () => {
    const events = chatSpendEvents([
      chat('codex', [
        message('assistant', at(12), { tokens: 1200 }),
        message('assistant', at(11), { tokens: 800 }),
      ]),
      chat('claude', [
        message('assistant', at(12), { costUsd: 0.1, tokens: 500 }),
      ]),
    ]);
    const summary = costSummary(events, now);
    expect(summary.thisMonth).toEqual({ usd: 0.1, tokens: 2000 });
    expect(formatSpend({ usd: 0, tokens: 2000 })).toBe('2,000 tokens');
    expect(formatSpend({ usd: 0.1, tokens: 2000 })).toBe(
      '$0.1000 + 2,000 tokens',
    );
    expect(formatSpend({ usd: 0, tokens: 0 })).toBe('$0.0000');
    expect(formatSpend({ usd: 12.345, tokens: 0 })).toBe('$12.35');
  });

  it('counts a reply once when a forked chat copies it', () => {
    const reply = message('assistant', at(12), { costUsd: 0.4 });
    const events = chatSpendEvents([
      chat('coder', [reply]),
      chat('coder', [
        reply,
        message('assistant', at(12, 11), { costUsd: 0.1 }),
      ]),
    ]);
    expect(costSummary(events, now).thisMonth.usd).toBeCloseTo(0.5);
  });

  it('charges delegated tasks to the worker and the checker by the day in the file name', () => {
    const task = (name: string, fm: Record<string, unknown>): NoteDocument => ({
      path: `Mesa/Tasks/${name}.md`,
      name,
      frontmatter: { agenthq: 'task', ...fm },
      body: '',
    });
    const events = taskSpendEvents([
      task('2026-11-12 0930 Write - ab12cd34', {
        toId: 'coder',
        verifierId: 'reviewer',
        workerTotalCostUsd: 0.3,
        verifierTotalCostUsd: 0.05,
      }),
      task('Untitled', { toId: 'coder', workerTotalCostUsd: 9 }),
    ]);
    const summary = costSummary(events, now);
    expect(summary.today.usd).toBeCloseTo(0.35);
    expect(summary.agents.map((a) => a.agentId)).toEqual(['coder', 'reviewer']);
  });
});
