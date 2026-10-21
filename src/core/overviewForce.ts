import { z } from 'zod';
import type { GraphAnalysis } from './graphMap';
import { clusterName } from './overviewLabels';

/** Vault overview limits. Past the cap the most linked notes are kept, and the view says how many were left out. */
export const FORCE_LIMITS = { nodes: 1500 } as const;

/** The "Display & forces" sliders: [min, max, step] for each number, and the defaults. */
export const OVERVIEW_RANGES = {
  nodeSize: [0.5, 3, 0.1],
  lineThickness: [0.5, 4, 0.1],
  centerForce: [0, 0.1, 0.005],
  repelForce: [10, 200, 5],
  linkForce: [0.05, 1, 0.05],
  linkDistance: [10, 100, 1],
} as const;

const slider = (key: keyof typeof OVERVIEW_RANGES, fallback: number) =>
  z
    .number()
    .min(OVERVIEW_RANGES[key][0])
    .max(OVERVIEW_RANGES[key][1])
    .catch(fallback);

export const overviewSettingsSchema = z.object({
  nodeSize: slider('nodeSize', 1),
  lineThickness: slider('lineThickness', 1),
  centerForce: slider('centerForce', 0.02),
  repelForce: slider('repelForce', 60),
  linkForce: slider('linkForce', 0.3),
  linkDistance: slider('linkDistance', 26),
  showLabels: z.boolean().catch(true),
  showOrphans: z.boolean().catch(true),
  showClusterList: z.boolean().catch(true),
});

export type OverviewSettings = z.infer<typeof overviewSettingsSchema>;

export const DEFAULT_OVERVIEW: OverviewSettings = overviewSettingsSchema.parse(
  {},
);

const GOLDEN_ANGLE = 137.50776405003785;
/** A cluster's colour, in degrees of hue. Golden-angle steps keep neighbouring clusters apart. */
export const clusterHue = (clusterNumber: number) =>
  (clusterNumber * GOLDEN_ANGLE) % 360;

export interface ForceNode {
  path: string;
  /** Cluster number, or 0 for a note with no links. */
  cluster: number;
  degree: number;
  hub: boolean;
  bridge: boolean;
  orphan: boolean;
  /** Radius in world units at node size 1: small, growing gently with links. */
  r: number;
  hue: number;
}

export interface ForceCluster {
  number: number;
  hub: string;
  /** Short display name: the shared folder, or the hub's short title. */
  name: string;
  count: number;
  hue: number;
  /** Indices of this cluster's nodes in the graph (only the ones shown). */
  nodes: number[];
}

export interface ForceGraph {
  nodes: ForceNode[];
  /** Pairs of node indices (a < b): one line each. */
  edges: [number, number][];
  clusters: ForceCluster[];
  /** Every note in the vault, shown or not. */
  total: number;
}

/**
 * The overview's data, from the same analysis as the graph map. Every note outside Obi-I is a node; links are edges.
 * Past the cap, the most linked notes are kept (ties by path), so hubs are always shown.
 */
export function buildForceGraph(
  analysis: GraphAnalysis,
  limit: number = FORCE_LIMITS.nodes,
): ForceGraph {
  const { graph } = analysis;
  const degree = (path: string) => graph.neighbours.get(path)?.size ?? 0;
  const ordered = graph.notes
    .map((note) => note.path)
    .sort((a, b) => degree(b) - degree(a) || a.localeCompare(b));
  const shown = ordered.slice(0, limit);
  const index = new Map(shown.map((path, i) => [path, i]));
  const hubs = new Set(analysis.hubs.map((hub) => hub.path));
  const bridges = new Set(analysis.bridges.map((bridge) => bridge.path));

  const nodes: ForceNode[] = shown.map((path) => {
    const cluster = analysis.clusterOf.get(path) ?? 0;
    const d = degree(path);
    const hub = hubs.has(path);
    return {
      path,
      cluster,
      degree: d,
      hub,
      bridge: bridges.has(path),
      orphan: d === 0,
      r: hub
        ? Math.min(8, 4 + 0.6 * Math.sqrt(d))
        : Math.min(6, 2.5 + 0.5 * Math.sqrt(d)),
      hue: cluster === 0 ? 0 : clusterHue(cluster),
    };
  });

  const edges: [number, number][] = [];
  for (const [path, a] of index)
    for (const other of graph.neighbours.get(path) ?? []) {
      const b = index.get(other);
      if (b !== undefined && a < b) edges.push([a, b]);
    }

  const clusters: ForceCluster[] = analysis.clusters.map((cluster) => ({
    number: cluster.number,
    hub: cluster.hub,
    name: clusterName(cluster.hub, cluster.members),
    count: cluster.members.length,
    hue: clusterHue(cluster.number),
    nodes: cluster.members
      .map((path) => index.get(path))
      .filter((i): i is number => i !== undefined),
  }));

  return { nodes, edges, clusters, total: graph.notes.length };
}

// The fixed simulation constants; the sliders set the rest. Picked so that linked notes gather within a few hundred steps.
const REPEL_RANGE = 120;
const ORPHAN_PUSH = 0.6;
/** Share of speed kept each step. High, so dots overshoot and wobble back like elastic. */
const VELOCITY_KEPT = 0.75;
const ALPHA_MIN = 0.005;
const ALPHA_DECAY = 0.0228;
/** How hot the simulation is held while a dot is dragged. */
const DRAG_HEAT = 0.5;

/**
 * A small force simulation, written here instead of a library: links pull neighbours together, nodes push apart within
 * a range (a grid keeps that cheap), a weak pull keeps the cloud together, and orphans drift to the edge. It cools
 * (alpha falls) until it settles, and then does no work until something reheats it (a drag).
 */
export class ForceSimulation {
  readonly x: Float64Array;
  readonly y: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly pinned: Uint8Array;
  private alpha = 1;

  constructor(
    private readonly graph: ForceGraph,
    private params: OverviewSettings = DEFAULT_OVERVIEW,
  ) {
    const n = graph.nodes.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.pinned = new Uint8Array(n);
    this.placeInitially();
  }

  /** Clusters start as small spirals around their own centres, so the simulation has less to untangle. */
  private placeInitially(): void {
    const groups = new Map<number, number[]>();
    this.graph.nodes.forEach((node, i) => {
      groups.set(node.cluster, [...(groups.get(node.cluster) ?? []), i]);
    });
    let k = 0;
    for (const [cluster, members] of [...groups].sort(([a], [b]) => a - b)) {
      if (cluster === 0) continue;
      const angle = k * GOLDEN_ANGLE * (Math.PI / 180);
      const cx = 60 * Math.sqrt(k + 1) * Math.cos(angle);
      const cy = 60 * Math.sqrt(k + 1) * Math.sin(angle);
      members.forEach((i, j) => {
        const a = j * GOLDEN_ANGLE * (Math.PI / 180);
        const d = 10 * Math.sqrt(j);
        this.x[i] = cx + d * Math.cos(a);
        this.y[i] = cy + d * Math.sin(a);
      });
      k++;
    }
    // Orphans start on a ring further out, where they will stay.
    (groups.get(0) ?? []).forEach((i, j) => {
      const a = j * GOLDEN_ANGLE * (Math.PI / 180);
      this.x[i] = 300 * Math.cos(a);
      this.y[i] = 300 * Math.sin(a);
    });
  }

  /** Applies new slider values and wakes the simulation so the layout moves to match. */
  setParams(params: OverviewSettings): void {
    this.params = params;
    this.reheat(0.6);
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN;
  }

  /** One step of cooling and movement. Does nothing once settled. */
  tick(): void {
    if (this.settled) return;
    const { nodes, edges } = this.graph;
    const { x, y, vx, vy, pinned } = this;
    const alpha = this.alpha;
    const { linkDistance, linkForce, repelForce, centerForce } = this.params;
    this.alpha += -this.alpha * ALPHA_DECAY;

    for (const [a, b] of edges) {
      const dx = x[b]! - x[a]!;
      const dy = y[b]! - y[a]!;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const pull = ((d - linkDistance) / d) * linkForce * alpha * 0.5;
      if (!pinned[a]) {
        vx[a]! += dx * pull;
        vy[a]! += dy * pull;
      }
      if (!pinned[b]) {
        vx[b]! -= dx * pull;
        vy[b]! -= dy * pull;
      }
    }

    // Repulsion: only pairs in neighbouring grid cells can be within range, so the work stays near linear.
    const cells = new Map<number, number[]>();
    const cellOf = (i: number) =>
      Math.floor(x[i]! / REPEL_RANGE) * 1_000_003 +
      Math.floor(y[i]! / REPEL_RANGE);
    for (let i = 0; i < nodes.length; i++) {
      const key = cellOf(i);
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    }
    const range2 = REPEL_RANGE * REPEL_RANGE;
    for (let i = 0; i < nodes.length; i++) {
      const cx = Math.floor(x[i]! / REPEL_RANGE);
      const cy = Math.floor(y[i]! / REPEL_RANGE);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          const list = cells.get((cx + ox) * 1_000_003 + (cy + oy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const dx = x[j]! - x[i]!;
            const dy = y[j]! - y[i]!;
            const d2 = dx * dx + dy * dy;
            if (d2 > range2) continue;
            const push = (repelForce * alpha) / Math.max(d2, 16);
            const d = Math.sqrt(d2) || 1e-6;
            if (!pinned[i]) {
              vx[i]! -= (dx / d) * push;
              vy[i]! -= (dy / d) * push;
            }
            if (!pinned[j]) {
              vx[j]! += (dx / d) * push;
              vy[j]! += (dy / d) * push;
            }
          }
        }
    }

    for (let i = 0; i < nodes.length; i++) {
      if (pinned[i]) continue;
      vx[i]! -= x[i]! * centerForce * alpha;
      vy[i]! -= y[i]! * centerForce * alpha;
      if (nodes[i]!.orphan) {
        const d = Math.sqrt(x[i]! * x[i]! + y[i]! * y[i]!) || 1e-6;
        vx[i]! += (x[i]! / d) * ORPHAN_PUSH * alpha;
        vy[i]! += (y[i]! / d) * ORPHAN_PUSH * alpha;
      }
      vx[i]! *= VELOCITY_KEPT;
      vy[i]! *= VELOCITY_KEPT;
      x[i]! += vx[i]!;
      y[i]! += vy[i]!;
    }
  }

  /** Runs until settled or the step cap is reached. Used by tests and by nothing else. */
  run(maxTicks = 2000): number {
    let ticks = 0;
    while (!this.settled && ticks < maxTicks) {
      this.tick();
      ticks++;
    }
    return ticks;
  }

  /** Holds a node where the user drags it. Dragging keeps the rest of the graph moving. */
  pin(i: number, wx: number, wy: number): void {
    this.pinned[i] = 1;
    this.x[i] = wx;
    this.y[i] = wy;
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.reheat(DRAG_HEAT);
  }

  unpin(i: number): void {
    this.pinned[i] = 0;
    this.reheat(DRAG_HEAT);
  }

  reheat(to: number): void {
    this.alpha = Math.max(this.alpha, to);
  }
}

/** Zoom and pan: screen = world × scale + (tx, ty). */
export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** The transform that fits the given nodes in a width × height box, with a margin. */
export function fitView(
  nodes: { x: number; y: number }[],
  width: number,
  height: number,
): ViewTransform {
  if (nodes.length === 0 || width <= 0 || height <= 0)
    return { scale: 1, tx: width / 2, ty: height / 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const margin = 40;
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(
    8,
    Math.max(
      0.1,
      Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY),
    ),
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { scale, tx: width / 2 - cx * scale, ty: height / 2 - cy * scale };
}
