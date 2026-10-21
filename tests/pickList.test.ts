import { describe, expect, it } from 'vitest';
import { filterPickItems, toggleIn } from '../src/core/pickList';
import { projectPickerState } from '../src/obsidian/views/projectMenu';
import type { Project } from '../src/core/projects';

const items = [
  { id: 'a', search: 'coder software engineer' },
  { id: 'b', search: 'reviewer' },
];

describe('project search and selection', () => {
  it('filters as you type, case-insensitively, and keeps everything for an empty query', () => {
    expect(filterPickItems(items, 'CODER').map((item) => item.id)).toEqual([
      'a',
    ]);
    expect(filterPickItems(items, '  ').map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps ticked items ticked when a search hides them', () => {
    const selected = ['a'];
    expect(filterPickItems(items, 'reviewer')).toHaveLength(1);
    expect(selected).toEqual(['a']);
    toggleIn(selected, 'b', true);
    toggleIn(selected, 'a', false);
    toggleIn(selected, 'b', true);
    expect(selected).toEqual(['b']);
  });
});

describe('project picker state', () => {
  const project = (id: string, name: string) => ({ id, name }) as Project;
  const mine = project('mine', 'Mine');
  const deleted = 'gone';

  it('shows and sends the selected, still-assigned project', () => {
    expect(projectPickerState('mine', [mine], [mine])).toEqual({
      badge: 'Mine',
      sendId: 'mine',
    });
  });

  it('shows "(deleted project)" for a project that no longer exists, and sends nothing', () => {
    expect(projectPickerState(deleted, [mine], [mine])).toEqual({
      badge: '(deleted project)',
      sendId: undefined,
    });
  });

  it('sends nothing for a known project that is no longer assigned, and shows no badge', () => {
    expect(projectPickerState('mine', [], [mine])).toEqual({
      badge: '',
      sendId: undefined,
    });
  });

  it('shows no badge when no project is selected', () => {
    expect(projectPickerState('', [mine], [mine])).toEqual({
      badge: '',
      sendId: undefined,
    });
  });
});
