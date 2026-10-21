import type { Agent } from './model';

export function getDirectReports(agents: Agent[], managerId: string): Agent[] {
  return agents.filter((agent) => agent.reportsTo === managerId);
}

export function wouldCreateCycle(
  agents: Agent[],
  agentId: string,
  managerId: string | null,
): boolean {
  const seen = new Set<string>([agentId]);
  let current = managerId;
  while (current !== null) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = agents.find((agent) => agent.id === current)?.reportsTo ?? null;
  }
  return false;
}

export function reparentAgent(
  agents: Agent[],
  agentId: string,
  managerId: string | null,
): Agent[] {
  if (!agents.some((agent) => agent.id === agentId))
    throw new Error('Unknown agent');
  if (managerId !== null && !agents.some((agent) => agent.id === managerId))
    throw new Error('Unknown manager');
  if (wouldCreateCycle(agents, agentId, managerId))
    throw new Error('That would create a loop in the org chart');
  return agents.map((agent) =>
    agent.id === agentId ? { ...agent, reportsTo: managerId } : agent,
  );
}

export function removeAgent(agents: Agent[], agentId: string): Agent[] {
  const manager =
    agents.find((agent) => agent.id === agentId)?.reportsTo ?? null;
  return agents
    .filter((agent) => agent.id !== agentId)
    .map((agent) =>
      agent.reportsTo === agentId ? { ...agent, reportsTo: manager } : agent,
    );
}

export function getDepth(agents: Agent[], agentId: string): number {
  const seen = new Set<string>([agentId]);
  let current = agents.find((agent) => agent.id === agentId)?.reportsTo ?? null;
  let depth = 0;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const manager = agents.find((agent) => agent.id === current);
    if (!manager) break;
    depth++;
    current = manager.reportsTo;
  }
  return depth;
}
