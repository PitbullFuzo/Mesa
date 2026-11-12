import { describe, expect, it } from 'vitest';
import {
  ALWAYS_ON_RIBBON,
  MESA_PAGES,
  OPTIONAL_RIBBON_PAGES,
  toggleRibbonExtra,
} from '../src/core/ribbon';
import { loadSettings } from '../src/core/settings';

describe('ribbon icons', () => {
  it('lists every page in the menu and keeps Obi, chat and graph always on', () => {
    expect(MESA_PAGES.map((page) => page.label)).toEqual([
      'Live activity',
      'Projects',
      'Schedules',
      'Skills',
      'Vault overview',
      'AI Graph',
      'Obi',
      'Mesa chat',
    ]);
    expect(ALWAYS_ON_RIBBON).toEqual(['obi', 'chat', 'graph']);
    expect(OPTIONAL_RIBBON_PAGES).toHaveLength(5);
  });
  it('shows no extra icons by default, for new and existing users', () => {
    expect(loadSettings(null).ribbonExtras).toEqual([]);
    expect(loadSettings({ agenthqFolder: 'Mesa' }).ribbonExtras).toEqual([]);
    expect(loadSettings({ ribbonExtras: 'nope' }).ribbonExtras).toEqual([]);
  });
  it('ticks and unticks extras, ignoring unknown and always-on ids', () => {
    expect(toggleRibbonExtra([], 'skills', true)).toEqual(['skills']);
    expect(toggleRibbonExtra(['skills'], 'activity', true)).toEqual([
      'activity',
      'skills',
    ]);
    expect(toggleRibbonExtra(['skills', 'x'], 'skills', false)).toEqual([]);
    expect(toggleRibbonExtra([], 'obi', true)).toEqual([]);
  });
});
