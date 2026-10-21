import type { Agent } from './model';

/** Pinned agents in pin order; ids that no longer name a valid agent are hidden. */
export function pinnedAgents(pins: string[], agents: Agent[]): Agent[] {
  return pins
    .map((id) => agents.find((agent) => agent.id === id))
    .filter((agent): agent is Agent => !!agent);
}

/** New pins go last; pinning an agent that is already pinned keeps its place. */
export function togglePin(
  pins: string[],
  id: string,
  pinned: boolean,
): string[] {
  const present = pins.includes(id);
  if (pinned) return present ? pins : [...pins, id];
  return pins.filter((pin) => pin !== id);
}

/** Text status symbols; native menus and selects cannot colour their entries. */
export const STATUS_GLYPH: Record<string, string> = {
  working: '●',
  queued: '◐',
  idle: '○',
  offline: '◌',
};

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? '•';
}
