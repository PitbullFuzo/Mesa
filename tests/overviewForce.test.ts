import { describe, expect, it } from 'vitest';
import {
  analyseLinkGraph,
  buildLinkGraph,
  type GraphAnalysis,
} from '../src/core/graphMap';
import {
  buildForceGraph,
  clusterHue,
  DEFAULT_OVERVIEW,
  FORCE_LIMITS,
  fitView,
  ForceSimulation,
} from '../src/core/overviewForce';
import { loadSettings } from '../src/core/settings';
import { incomingLinkCounts, type VaultFile } from '../src/core/vaultMap';

function analysisOf(
  paths: string[],
  links: Record<string, Record<string, number>>,
): GraphAnalysis {
  const incoming = incomingLinkCounts(links, 'Mesa', '.obsidian');
  const files: VaultFile[] = paths.map((path, index) => ({
    path,
    mtime: index + 1,
    incomingLinks: incoming.get(path) ?? 0,
  }));
  return analyseLinkGraph(buildLinkGraph(files, links, 'Mesa', '.obsidian'));
}

/** Two triangles joined by one link, and one note with no links. */
const sample = () =>
  analysisOf(
    [
      'Notes/a1.md',
      'Notes/a2.md',
      'Notes/a3.md',
      'Ideas/b1.md',
      'Ideas/b2.md',
      'Ideas/b3.md',
      'Misc/lonely.md',
    ],
    {
      'Notes/a1.md': { 'Notes/a2.md': 1, 'Notes/a3.md': 1 },
      'Notes/a2.md': { 'Notes/a3.md': 1 },
      'Notes/a3.md': { 'Ideas/b1.md': 1 },
      'Ideas/b1.md': { 'Ideas/b2.md': 1, 'Ideas/b3.md': 1 },
      'Ideas/b2.md': { 'Ideas/b3.md': 1 },
    },
  );

/** Three cliques of six notes with no links between them. */
const cliques = () => {
  const paths: string[] = [];
  const links: Record<string, Record<string, number>> = {};
  for (let c = 0; c < 3; c++) {
    const group = Array.from({ length: 6 }, (_, i) => `Group${c}/n${i}.md`);
    paths.push(...group);
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        links[group[i]!] = { ...links[group[i]!], [group[j]!]: 1 };
  }
  return analysisOf(paths, links);
};

const distance = (sim: ForceSimulation, a: number, b: number) =>
  Math.hypot(sim.x[a]! - sim.x[b]!, sim.y[a]! - sim.y[b]!);

describe('the overview data', () => {
  it('makes every note a node, with its cluster colour, hub, bridge and orphan flags', () => {
    const analysis = sample();
    const graph = buildForceGraph(analysis);
    expect(graph.nodes).toHaveLength(7);
    expect(graph.total).toBe(7);
    const lonely = graph.nodes.find((node) => node.path === 'Misc/lonely.md')!;
    expect(lonely.orphan).toBe(true);
    expect(lonely.cluster).toBe(0);
    const b1 = graph.nodes.find((node) => node.path === 'Ideas/b1.md')!;
    expect(b1.bridge).toBe(true);
    expect(b1.hue).toBe(clusterHue(b1.cluster));
    expect(graph.nodes.some((node) => node.hub)).toBe(true);
    expect(graph.edges).toHaveLength(7);
    expect(graph.clusters).toHaveLength(2);
    for (const cluster of graph.clusters) expect(cluster.nodes).toHaveLength(3);
  });

  it('keeps the most linked notes when the vault is over the cap, and says how many were left out', () => {
    const paths = ['Hub/center.md'];
    const links: Record<string, Record<string, number>> = {};
    const leaves = Array.from(
      { length: FORCE_LIMITS.nodes + 500 },
      (_, i) => `Leaves/l${i}.md`,
    );
    paths.push(...leaves);
    links['Hub/center.md'] = Object.fromEntries(
      leaves.map((path) => [path, 1]),
    );
    const graph = buildForceGraph(analysisOf(paths, links));
    expect(graph.nodes).toHaveLength(FORCE_LIMITS.nodes);
    expect(graph.total).toBe(leaves.length + 1);
    // The most linked note is the one kept: its degree is every link it has, shown or not.
    const center = graph.nodes.find((node) => node.path === 'Hub/center.md');
    expect(center?.degree).toBe(leaves.length);
    for (const [a, b] of graph.edges) expect(a).toBeLessThan(b);
  });

  it('is the same every time for the same analysis', () => {
    const analysis = sample();
    expect(buildForceGraph(analysis)).toEqual(buildForceGraph(analysis));
  });
});

describe('the force simulation', () => {
  it('settles, and then does no more work', () => {
    const sim = new ForceSimulation(buildForceGraph(sample()));
    const ticks = sim.run();
    expect(sim.settled).toBe(true);
    expect(ticks).toBeLessThan(2000);
    const before = [...sim.x, ...sim.y];
    sim.tick();
    expect([...sim.x, ...sim.y]).toEqual(before);
  });

  it('never produces a number that is not finite', () => {
    const sim = new ForceSimulation(buildForceGraph(cliques()));
    sim.run();
    for (const value of [...sim.x, ...sim.y])
      expect(Number.isFinite(value)).toBe(true);
  });

  it('gathers linked notes together and pushes separate clusters apart', () => {
    const graph = buildForceGraph(cliques());
    const sim = new ForceSimulation(graph);
    sim.run();
    const pairs = (from: number[], to: number[]) => {
      const out: number[] = [];
      for (const a of from)
        for (const b of to) if (a !== b) out.push(distance(sim, a, b));
      return out;
    };
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const groups = graph.clusters.map((cluster) => cluster.nodes);
    const within = mean(groups.flatMap((group) => pairs(group, group)));
    const between = mean(
      groups.flatMap((group, i) =>
        groups.slice(i + 1).flatMap((other) => pairs(group, other)),
      ),
    );
    expect(within).toBeLessThan(between * 0.7);
  });

  it('pushes the notes with no links to the edge, outside the clusters', () => {
    const graph = buildForceGraph(sample());
    const sim = new ForceSimulation(graph);
    sim.run();
    const radius = (i: number) => Math.hypot(sim.x[i]!, sim.y[i]!);
    const lonely = graph.nodes.findIndex((node) => node.orphan);
    const clustered = graph.nodes
      .map((_, i) => i)
      .filter((i) => !graph.nodes[i]!.orphan);
    const average =
      clustered.reduce((sum, i) => sum + radius(i), 0) / clustered.length;
    expect(radius(lonely)).toBeGreaterThan(average);
  });

  it('holds a dragged node where it was put', () => {
    const sim = new ForceSimulation(buildForceGraph(sample()));
    sim.pin(0, 500, -200);
    sim.run();
    expect(sim.x[0]).toBe(500);
    expect(sim.y[0]).toBe(-200);
  });
});

describe('fitting the view', () => {
  it('fits every node inside the box', () => {
    const nodes = [
      { x: -300, y: 80 },
      { x: 220, y: -150 },
      { x: 10, y: 40 },
    ];
    const view = fitView(nodes, 400, 300);
    for (const node of nodes) {
      const sx = node.x * view.scale + view.tx;
      const sy = node.y * view.scale + view.ty;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(400);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(300);
    }
  });
});

describe('the display and force settings', () => {
  it('start at the defaults, and fall back to them when saved values are bad', () => {
    expect(loadSettings(null).overview).toEqual(DEFAULT_OVERVIEW);
    const bad = loadSettings({
      overview: { nodeSize: 99, repelForce: 'x', showLabels: false },
    });
    expect(bad.overview.nodeSize).toBe(DEFAULT_OVERVIEW.nodeSize);
    expect(bad.overview.repelForce).toBe(DEFAULT_OVERVIEW.repelForce);
    expect(bad.overview.showLabels).toBe(false);
  });

  it('are saved and loaded again', () => {
    const saved = {
      ...DEFAULT_OVERVIEW,
      nodeSize: 2,
      linkDistance: 50,
      showOrphans: false,
    };
    expect(loadSettings({ overview: saved }).overview).toEqual(saved);
  });

  it('keeps dots small by default, with hubs only moderately bigger', () => {
    const graph = buildForceGraph(sample());
    for (const node of graph.nodes) expect(node.r).toBeLessThanOrEqual(8);
  });

  it('changes the layout when a force changes, and wakes a settled simulation', () => {
    const graph = buildForceGraph(cliques());
    const sim = new ForceSimulation(graph);
    sim.run();
    expect(sim.settled).toBe(true);
    const spread = () =>
      Math.max(...Array.from(sim.x, (x, i) => Math.hypot(x, sim.y[i]!)));
    const before = spread();
    sim.setParams({ ...DEFAULT_OVERVIEW, repelForce: 200 });
    expect(sim.settled).toBe(false);
    sim.run();
    expect(spread()).toBeGreaterThan(before);
    expect(sim.settled).toBe(true);
  });

  it('is elastic: a dragged node pulls its neighbours, and everything settles after release', () => {
    const graph = buildForceGraph(cliques());
    const sim = new ForceSimulation(graph);
    sim.run();
    const other = graph.clusters[0]!.nodes[1]!;
    const before = sim.x[other]!;
    sim.pin(graph.clusters[0]!.nodes[0]!, sim.x[other]! + 400, sim.y[other]!);
    for (let i = 0; i < 30; i++) sim.tick();
    expect(sim.x[other]).toBeGreaterThan(before);
    sim.unpin(graph.clusters[0]!.nodes[0]!);
    sim.run();
    expect(sim.settled).toBe(true);
  });
});
