import { describe, expect, it } from 'vitest';
import type { AgentChatSnapshot } from '../src/core/chat';
import {
  elapsed,
  liveRows,
  liveSummary,
  recentActivity,
} from '../src/core/liveActivity';

const agent = (
  id: string,
  status: AgentChatSnapshot['status'],
  messages: AgentChatSnapshot['messages'] = [],
): AgentChatSnapshot =>
  ({
    agent: { id, name: id[0]!.toUpperCase() + id.slice(1) },
    status,
    session: null,
    messages,
    history: [],
  }) as unknown as AgentChatSnapshot;

const user = (content: string, timestamp = '2026-11-05T10:00:00.000Z') => ({
  role: 'user' as const,
  content,
  timestamp,
  tools: [],
});
const reply = (tools: { name: string; summary: string }[]) => ({
  role: 'assistant' as const,
  content: '',
  timestamp: '2026-11-05T10:00:05.000Z',
  tools,
  streaming: true,
});

describe('live activity', () => {
  it('shows what each agent works on and its latest step, busiest first', () => {
    const rows = liveRows(
      {
        idle: agent('idle', 'idle'),
        writer: agent('writer', 'working', [
          user('old question'),
          reply([{ name: 'Read', summary: 'old.md' }]),
          user('Write chapter 3\nwith the twist'),
          reply([
            { name: 'Read', summary: 'wiki/Plot.md' },
            { name: 'Write', summary: 'Book/Chapter 3.md' },
          ]),
        ]),
        keeper: agent('keeper', 'needs-you', [user('Check continuity')]),
      },
      { writer: { round: 2, rounds: 5 } },
    );
    expect(rows.map((row) => row.id)).toEqual(['writer', 'keeper', 'idle']);
    expect(rows[0]).toMatchObject({
      doing: 'Write chapter 3',
      lastStep: 'Write: Book/Chapter 3.md',
      steps: 2,
      since: '2026-11-05T10:00:00.000Z',
      loop: { round: 2, rounds: 5 },
    });
    expect(rows[1]).toMatchObject({ doing: 'Check continuity', steps: 0 });
    expect(rows[1]!.lastStep).toBeUndefined();
    expect(rows[2]!.doing).toBeUndefined();
  });

  it('shortens long requests', () => {
    const [row] = liveRows({
      a: agent('a', 'working', [user('x'.repeat(500))]),
    });
    expect(row!.doing!.length).toBe(140);
    expect(row!.doing!.endsWith('…')).toBe(true);
  });

  it('sums up what is running', () => {
    const rows = liveRows({
      a: agent('a', 'working'),
      b: agent('b', 'working'),
      c: agent('c', 'needs-you'),
      d: agent('d', 'queued'),
      e: agent('e', 'idle'),
    });
    expect(liveSummary(rows)).toBe(
      '2 working · 1 needs you · 1 waiting to start',
    );
    expect(liveSummary(liveRows({ e: agent('e', 'idle') }))).toBe(
      'Nothing is running.',
    );
  });

  it('says how long it has been going', () => {
    const start = '2026-11-05T10:00:00.000Z';
    expect(elapsed(start, new Date('2026-11-05T10:00:42.000Z'))).toBe(
      'for 42 s',
    );
    expect(elapsed(start, new Date('2026-11-05T10:03:10.000Z'))).toBe(
      'for 3 min',
    );
    expect(elapsed(start, new Date('2026-11-05T11:05:00.000Z'))).toBe(
      'for 1 h 5 min',
    );
  });

  it('lists the newest Activity lines first, across months', () => {
    const note = (name: string, body: string) => ({
      path: `Mesa/Activity/${name}.md`,
      name,
      frontmatter: {},
      body,
    });
    const lines = recentActivity(
      [
        note('2026-10', '- 09:00 October one\n- 10:00 October two\n'),
        note(
          '2026-11',
          '- 08:00 November one\nnot a line\n- 09:30 November two\n',
        ),
        note('Notes', '- 01:00 not an Activity month\n'),
      ],
      3,
    );
    expect(lines).toEqual([
      '09:30 November two',
      '08:00 November one',
      '10:00 October two',
    ]);
  });

  it('reads both the old HH:MM lines and the new dated lines', () => {
    const lines = recentActivity([
      {
        path: 'Mesa/Activity/2026-11.md',
        name: '2026-11',
        frontmatter: {},
        body: '- 08:00 Old style\n- 2026-11-12 09:30 New style\n- 2026-11-12 9:3 broken\n',
      },
    ]);
    expect(lines).toEqual(['2026-11-12 09:30 New style', '08:00 Old style']);
  });
});
