import type { Agent, Group } from './model';
import type { Layout, Point } from './workspace';

export const GRAPH_AGENT_WIDTH = 224;
export const GRAPH_AGENT_HEIGHT = 116;

/** Visible frame bounds may differ from its persisted anchor as members move freely. */
export function graphGroupFrame(
  anchor: Point,
  members: Point[],
): {
  position: Point;
  width: number;
  height: number;
} {
  const x = Math.min(anchor.x, ...members.map((point) => point.x - 32));
  const y = Math.min(anchor.y, ...members.map((point) => point.y - 64));
  const right = Math.max(
    anchor.x + 320,
    ...members.map((point) => point.x + GRAPH_AGENT_WIDTH + 32),
  );
  const bottom = Math.max(
    anchor.y + 200,
    ...members.map((point) => point.y + GRAPH_AGENT_HEIGHT + 32),
  );
  return { position: { x, y }, width: right - x, height: bottom - y };
}

/** Absolute vault-persisted coordinates; group keys are anchors, never child offsets. */
export function graphLayoutPositions(
  agents: Agent[],
  groups: Group[],
  layout: Layout,
): Layout {
  const positions: Layout = {};
  const sortedGroups = [...groups].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, group] of sortedGroups.entries()) {
    positions[`group:${group.id}`] = {
      ...(layout[`group:${group.id}`] ?? {
        x: (index % 2) * 1040,
        y: Math.floor(index / 2) * 760,
      }),
    };
  }
  const counts = new Map<string, number>();
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const key =
      agent.group && positions[`group:${agent.group}`] ? agent.group : '';
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    const anchor: Point = key
      ? positions[`group:${key}`]!
      : {
          x: 0,
          y: Math.ceil(sortedGroups.length / 2) * 760,
        };
    positions[agent.id] = {
      ...(layout[agent.id] ?? {
        x: anchor.x + 32 + (index % 3) * 256,
        y: anchor.y + 64 + Math.floor(index / 3) * 176,
      }),
    };
  }
  return positions;
}
