import { describe, expect, it } from 'vitest';
import { readableReply } from '../src/core/chatDisplay';

const block = (kind: string, json: unknown) =>
  `\`\`\`agenthq-${kind}\n${typeof json === 'string' ? json : JSON.stringify(json)}\n\`\`\``;

describe('replies as the chat shows them', () => {
  it('leaves ordinary replies and code blocks alone', () => {
    const text = 'Hello\n```js\nconst a = 1;\n```';
    expect(readableReply(text)).toBe(text);
  });

  it('shows team changes, hand-offs, reviews, memory and reorganisation as plain lines, never JSON', () => {
    const text = [
      'Here is my plan.',
      block('admin', {
        actions: [
          { type: 'createAgent', name: 'SEO Lead' },
          { type: 'createGroup', name: 'SEO' },
        ],
      }),
      block('delegate', {
        tasks: [
          { to: 'Writer', task: 'Draft the blog post about composting.' },
        ],
      }),
      block('verdict', { verdict: 'fail', feedback: 'The intro is missing.' }),
      block('memory', { memories: [{ text: 'a' }, { text: 'b' }] }),
      block('reorg', { moves: [{ from: 'a.md', to: 'B/a.md' }], merges: [] }),
    ].join('\n\n');
    const shown = readableReply(text);
    expect(shown).not.toContain('```agenthq');
    expect(shown).not.toContain('"type"');
    expect(shown).toContain('Here is my plan.');
    expect(shown).toContain('Proposed team changes (2)');
    expect(shown).toContain('Writer: Draft the blog post about composting.');
    expect(shown).toContain('Review: needs changes** — The intro is missing.');
    expect(shown).toContain('Remembered 2 things');
    expect(shown).toContain('1 move.');
  });

  it('keeps a block it cannot read, so the problem stays visible', () => {
    const broken = block('admin', '{not json');
    expect(readableReply(broken)).toBe(broken);
    const unfinished = '```agenthq-delegate\n{"tasks":[';
    expect(readableReply(unfinished)).toBe(unfinished);
  });
});
