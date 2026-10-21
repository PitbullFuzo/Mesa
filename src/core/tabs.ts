import type { AgentTab } from './workspace';
import { agentDisplayName, type ObiAction } from './obi';
import type { Agent } from './model';

const TABS: AgentTab[] = ['chat', 'setup', 'tasks', 'history'];

/** What an Agent tab stores in its view state. Unknown or broken state falls back to Chat. */
export function tabState(
  raw: unknown,
): { agentId: string; tab: AgentTab } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { agentId, tab } = raw as { agentId?: unknown; tab?: unknown };
  if (typeof agentId !== 'string' || !agentId) return null;
  return {
    agentId,
    tab: TABS.includes(tab as AgentTab) ? (tab as AgentTab) : 'chat',
  };
}

/** Index of the tab already showing this agent, or -1: opening an agent focuses it instead of duplicating it. */
export function findAgentTab(
  tabs: { agentId: string }[],
  agentId: string,
): number {
  return tabs.findIndex((tab) => tab.agentId === agentId);
}

/** The agent a proposal changes, so its tab can open beside Obi. */
export function affectedAgentId(
  action: ObiAction,
  agents: Agent[],
): string | null {
  const byRef = (ref: string) =>
    agents.find(
      (agent) =>
        agent.id === ref || agent.name.toLowerCase() === ref.toLowerCase(),
    )?.id ?? null;
  switch (action.type) {
    case 'createAgent':
      return byRef(action.name);
    case 'updateAgent':
    case 'setManager':
      return byRef(action.id);
    default:
      return null;
  }
}

/**
 * Where an agent opens. The first agent uses the placement (side panel or main area). In main-area
 * mode additional agents are main tabs; in side mode an agent opens in a pop-out window only when
 * the side panel is already occupied. An explicit "Open in new window" always opens a window.
 */
export function openPlan(input: {
  existing: boolean;
  placement: 'side' | 'main';
  sideOccupied: boolean;
  windowRequested: boolean;
  windowsAvailable: boolean;
}): 'reveal' | 'side' | 'main' | 'window' {
  if (input.existing) return 'reveal';
  const usual = input.placement === 'main' ? 'main' : 'side';
  if (input.windowRequested) return input.windowsAvailable ? 'window' : usual;
  if (input.placement === 'main') return 'main';
  return input.sideOccupied && input.windowsAvailable ? 'window' : 'side';
}

/** Tab title: the agent's display name, or "Agent" while no agent is bound. */
export function agentTabTitle(agent: Agent | undefined): string {
  return agent ? agentDisplayName(agent) : 'Agent';
}
