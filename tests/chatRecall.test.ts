import { describe, expect, it } from 'vitest';
import { chatRecallSection, isRecallRequest } from '../src/core/chatRecall';
import type { NoteDocument } from '../src/core/notes';

const chat = (
  name: string,
  agentId: string,
  started: string,
  body: string,
): NoteDocument => ({
  path: `Obi-I/Chats/${name}.md`,
  name,
  frontmatter: { agenthq: 'chat', agentId, started, title: name },
  body,
});

const chats = [
  chat(
    'Pricing talk',
    'a1',
    '2026-10-01T10:00:00Z',
    'We decided the pricing plan will use annual billing with a discount.',
  ),
  chat(
    'Other agent pricing',
    'a2',
    '2026-10-02T10:00:00Z',
    'Secret pricing plan of the other agent: monthly billing.',
  ),
  chat(
    'Current chat',
    'a1',
    '2026-10-20T10:00:00Z',
    'This current chat mentions the pricing plan too.',
  ),
  chat(
    'Lunch',
    'a1',
    '2026-10-03T10:00:00Z',
    'We talked about lunch and sandwiches.',
  ),
];

const recall = (message: string) =>
  chatRecallSection(
    message,
    chats,
    'a1',
    'Obi-I/Chats/Current chat.md',
    new Map(),
  );

describe('chat recall', () => {
  it('recognises looking back in English and Portuguese, and not ordinary messages', () => {
    for (const text of [
      'what did we decide last time about pricing?',
      'remember when we talked about it',
      'da última vez que falámos',
      'tu disseste que o plano era anual',
    ])
      expect(isRecallRequest(text), text).toBe(true);
    for (const text of ['write a pricing plan', 'escreve um resumo do plano'])
      expect(isRecallRequest(text), text).toBe(false);
  });

  it('brings back the right passage from an older chat, with its title and date', () => {
    const section = recall(
      'what did we decide last time about the pricing plan?',
    );
    expect(section).toContain('## From your earlier conversations');
    expect(section).toContain('"Pricing talk" (2026-10-01)');
    expect(section).toContain('annual billing');
  });

  it("never shows other agents' chats or the current chat", () => {
    const section = recall(
      'what did we decide last time about the pricing plan?',
    );
    expect(section).not.toContain('other agent');
    expect(section).not.toContain('monthly billing');
    expect(section).not.toContain('This current chat');
  });

  it('adds nothing without a trigger, or when nothing matches', () => {
    expect(recall('what is the pricing plan?')).toBe('');
    expect(recall('what did we decide last time about zebras?')).toBe('');
  });

  it('stays under the word cap', () => {
    const section = chatRecallSection(
      'last time pricing plan',
      chats,
      'a1',
      undefined,
      new Map(),
      5,
    );
    expect(section).toBe('');
  });
});
