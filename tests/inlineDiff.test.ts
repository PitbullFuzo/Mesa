import { describe, expect, it } from 'vitest';
import {
  BIG_CHANGE,
  changeShare,
  groupChanges,
  isBigChange,
  wordDiff,
  type DiffSegment,
} from '../src/core/inlineEdit';
import { loadSettings } from '../src/core/settings';

const segments = (before: string, after: string) =>
  groupChanges(wordDiff(before, after));

/** The text as it was, and as it becomes, rebuilt from the segments. */
const rebuild = (parts: DiffSegment[]) => ({
  before: parts.map((p) => (p.type === 'same' ? p.text : p.del)).join(''),
  after: parts.map((p) => (p.type === 'same' ? p.text : p.add)).join(''),
});

describe('the readable diff', () => {
  it('groups a change into one phrase: what was deleted, then what was inserted', () => {
    expect(
      segments(
        'The quick brown fox jumps over the dog',
        'The slow brown fox leaps over the cat',
      ),
    ).toEqual([
      { type: 'same', text: 'The ' },
      { type: 'change', del: 'quick', add: 'slow' },
      { type: 'same', text: ' brown fox ' },
      { type: 'change', del: 'jumps', add: 'leaps' },
      { type: 'same', text: ' over the ' },
      { type: 'change', del: 'dog', add: 'cat' },
    ]);
  });

  it('keeps several changed words together, with their own spaces, as one phrase', () => {
    expect(segments('so how do you do', 'então, como vai você')).toEqual([
      {
        type: 'change',
        del: 'so how do you do',
        add: 'então, como vai você',
      },
    ]);
    expect(
      segments(
        'Hello so how are you today',
        'Hello então, como vai você today',
      ),
    ).toEqual([
      { type: 'same', text: 'Hello ' },
      { type: 'change', del: 'so how are you', add: 'então, como vai você' },
      { type: 'same', text: ' today' },
    ]);
  });

  it('never glues the two sides to each other or to the words around them', () => {
    const parts = segments('one two three four', 'one 2 3 four');
    for (const [index, part] of parts.entries()) {
      if (part.type !== 'change') continue;
      expect(part.del).toBe(part.del.trim());
      expect(part.add).toBe(part.add.trim());
      const before = parts[index - 1];
      const after = parts[index + 1];
      if (before?.type === 'same') expect(before.text).toMatch(/\s$/);
      if (after?.type === 'same') expect(after.text).toMatch(/^\s/);
    }
  });

  it('rebuilds both texts word for word, and handles an insertion, a deletion and no change', () => {
    for (const [before, after] of [
      ['a b c', 'a x c'],
      ['a b c', 'a c'],
      ['a c', 'a b c'],
      ['same', 'same'],
      ['', 'new text'],
      ['old text', ''],
    ] as const) {
      const out = rebuild(segments(before, after));
      expect(out.before.replace(/\s+/g, ' ').trim()).toBe(before);
      expect(out.after.replace(/\s+/g, ' ').trim()).toBe(after);
    }
    expect(segments('a b c', 'a c')).toEqual([
      { type: 'same', text: 'a ' },
      { type: 'change', del: 'b', add: '' },
      { type: 'same', text: ' c' },
    ]);
  });
});

describe('big rewrites', () => {
  it('count as big above half of the words changing, not for a small edit', () => {
    expect(BIG_CHANGE).toBe(0.5);
    const small = wordDiff(
      'The quick brown fox jumps over the lazy dog today',
      'The quick brown fox leaps over the lazy dog today',
    );
    expect(changeShare(small)).toBeLessThan(0.2);
    expect(isBigChange(small)).toBe(false);
    const translation = wordDiff(
      'so how do you do everyone',
      'então, como vai você todos',
    );
    expect(changeShare(translation)).toBe(1);
    expect(isBigChange(translation)).toBe(true);
  });

  it('are decided on the share of changed words, with the threshold itself not big', () => {
    // Two words kept (counted on both sides), two changed on each side: 4 / (4 + 4) = exactly half.
    expect(changeShare(wordDiff('a b x y', 'a b p q'))).toBe(0.5);
    expect(isBigChange(wordDiff('a b x y', 'a b p q'))).toBe(false);
    expect(isBigChange(wordDiff('a x y z', 'a p q r'))).toBe(true);
    expect(changeShare([])).toBe(0);
  });
});

describe('the remembered layout', () => {
  it('starts automatic, keeps the last choice, and ignores a bad saved value', () => {
    expect(loadSettings(null).inlineEditLayout).toBe('');
    expect(loadSettings({ inlineEditLayout: 'blocks' }).inlineEditLayout).toBe(
      'blocks',
    );
    expect(loadSettings({ inlineEditLayout: 'wide' }).inlineEditLayout).toBe(
      '',
    );
  });
});
