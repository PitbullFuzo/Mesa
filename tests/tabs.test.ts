import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/model';
import {
  affectedAgentId,
  agentTabTitle,
  findAgentTab,
  openPlan,
  tabState,
} from '../src/core/tabs';

describe('agent tabs', () => {
  it('restores a saved tab and falls back to Chat for broken state', () => {
    expect(tabState({ agentId: 'ceo', tab: 'setup' })).toEqual({
      agentId: 'ceo',
      tab: 'setup',
    });
    expect(tabState({ agentId: 'ceo', tab: 'bogus' })).toEqual({
      agentId: 'ceo',
      tab: 'chat',
    });
    expect(tabState({ tab: 'chat' })).toBeNull();
    expect(tabState(null)).toBeNull();
  });

  it('focuses the existing tab for an agent instead of opening a second one', () => {
    const tabs = [{ agentId: 'ceo' }, { agentId: 'obi' }];
    expect(findAgentTab(tabs, 'ceo')).toBe(0);
    expect(findAgentTab(tabs, 'coder')).toBe(-1);
  });

  it('names the agent an approved create or update changes, never Obi itself', () => {
    const agents = [
      { id: 'obi', name: 'Obi' },
      { id: 'researcher', name: 'Researcher' },
    ] as Agent[];
    expect(
      affectedAgentId({ type: 'createAgent', name: 'Researcher' }, agents),
    ).toBe('researcher');
    expect(
      affectedAgentId({ type: 'updateAgent', id: 'Researcher' }, agents),
    ).toBe('researcher');
    expect(
      affectedAgentId(
        { type: 'createGroup', name: 'X', color: '#000000' },
        agents,
      ),
    ).toBeNull();
  });
});

describe('where an agent opens', () => {
  const base = {
    existing: false,
    placement: 'side' as const,
    sideOccupied: false,
    windowRequested: false,
    windowsAvailable: true,
  };
  it('reveals an agent that already has a panel or window', () => {
    expect(openPlan({ ...base, existing: true, sideOccupied: true })).toBe(
      'reveal',
    );
  });
  it('puts the first side-mode agent in the side panel', () => {
    expect(openPlan(base)).toBe('side');
  });
  it('opens a second agent in a window when the side panel is occupied', () => {
    expect(openPlan({ ...base, sideOccupied: true })).toBe('window');
  });
  it('opens agents as main-area tabs in full-screen mode, never windows', () => {
    expect(openPlan({ ...base, placement: 'main' })).toBe('main');
    expect(openPlan({ ...base, placement: 'main', sideOccupied: true })).toBe(
      'main',
    );
  });
  it('opens an explicit new window even when the side panel is free', () => {
    expect(openPlan({ ...base, windowRequested: true })).toBe('window');
  });
  it('falls back to the usual place where windows are not available', () => {
    expect(
      openPlan({ ...base, sideOccupied: true, windowsAvailable: false }),
    ).toBe('side');
  });
});

describe('agent tab titles', () => {
  it('shows the display name of the bound agent, and Agent when none is bound', () => {
    expect(agentTabTitle({ id: 'ceo', name: 'CEO' } as Agent)).toBe('CEO');
    expect(agentTabTitle({ id: 'obi', name: 'Obi' } as Agent)).toBe('Obi');
    expect(agentTabTitle(undefined)).toBe('Agent');
  });
});
