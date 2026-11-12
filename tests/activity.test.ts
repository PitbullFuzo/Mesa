import { describe, expect, it, vi } from 'vitest';
import {
  activityLine,
  activityNotePath,
  appendActivityLine,
} from '../src/core/activity';
import { MemoryStore } from '../src/core/memoryStore';

describe('Activity log', () => {
  const day = new Date(2026, 10, 3, 9, 5);

  it('writes dated lines into the month note', () => {
    expect(activityNotePath('Mesa', day)).toBe('Mesa/Activity/2026-11.md');
    expect(activityLine('Coder finished', day)).toBe(
      '- 2026-11-03 09:05 Coder finished',
    );
  });

  it('appends to this month only, without reading the other Activity notes', async () => {
    const store = new MemoryStore('Mesa');
    await appendActivityLine(store, 'Mesa', 'one', new Date(2026, 9, 30, 8, 0));
    await appendActivityLine(store, 'Mesa', 'two', day);
    const loadAll = vi.spyOn(store, 'loadActivity');
    await appendActivityLine(store, 'Mesa', 'three', day);
    expect(loadAll).not.toHaveBeenCalled();
    const november = store.notes.get('Mesa/Activity/2026-11.md');
    expect(november?.body).toBe(
      '- 2026-11-03 09:05 two\n- 2026-11-03 09:05 three\n',
    );
    expect(store.notes.get('Mesa/Activity/2026-10.md')?.body).toBe(
      '- 2026-10-30 08:00 one\n',
    );
  });
});

describe('Activity log writes', () => {
  it('keeps every line when several are written at the same moment', async () => {
    const store = new MemoryStore('Mesa');
    const day = new Date(2026, 10, 3, 9, 5);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((text) =>
        appendActivityLine(store, 'Mesa', text, day),
      ),
    );
    expect(store.notes.get('Mesa/Activity/2026-11.md')?.body).toBe(
      '- 2026-11-03 09:05 a\n- 2026-11-03 09:05 b\n- 2026-11-03 09:05 c\n- 2026-11-03 09:05 d\n',
    );
  });
});
