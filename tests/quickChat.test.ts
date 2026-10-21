import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/model';
import { MemoryStore } from '../src/core/memoryStore';
import { pinnedAgents, statusGlyph, togglePin } from '../src/core/quickChat';

function agent(id: string): Agent {
  return { id, name: id.toUpperCase() } as Agent;
}

const agents = [agent('coder'), agent('designer'), agent('scribe')];

describe('pinned agents', () => {
  it('lists pins in pin order and hides ids that no longer name an agent', () => {
    const shown = pinnedAgents(['scribe', 'gone', 'coder'], agents);
    expect(shown.map((entry) => entry.id)).toEqual(['scribe', 'coder']);
  });

  it('shows nothing when nothing is pinned', () => {
    expect(pinnedAgents([], agents)).toEqual([]);
  });
});

describe('pin toggling', () => {
  it('appends a new pin and keeps an existing pin in place', () => {
    expect(togglePin(['coder'], 'designer', true)).toEqual([
      'coder',
      'designer',
    ]);
    expect(togglePin(['coder', 'designer'], 'coder', true)).toEqual([
      'coder',
      'designer',
    ]);
  });

  it('removes an unpinned agent and leaves the rest in order', () => {
    expect(
      togglePin(['coder', 'designer', 'scribe'], 'designer', false),
    ).toEqual(['coder', 'scribe']);
  });

  it('shows a bullet for an unknown status', () => {
    expect(statusGlyph('working')).toBe('●');
    expect(statusGlyph('unknown-status')).toBe('•');
  });
});

describe('pins persist in plugin data', () => {
  it('returns the saved pins, in order, from the store', async () => {
    const store = new MemoryStore();
    expect(await store.loadPins()).toEqual([]);
    await store.savePins(['scribe', 'coder']);
    expect(await store.loadPins()).toEqual(['scribe', 'coder']);
  });
});
