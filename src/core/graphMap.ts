import { wordCount } from './memory';
import type { Store } from './store';
import {
  dontDeleteCallout,
  GRAPH_MAP_NAME,
  isVaultSearchable,
  type VaultFile,
} from './vaultMap';

export const GRAPH_MAP_LIMITS = {
  hubs: 8,
  clusters: 10,
  membersPerCluster: 5,
  bridges: 10,
  orphans: 30,
  maxWords: 1500,
} as const;
const LOUVAIN_ROUNDS = 30;
const LOUVAIN_LEVELS = 10;

/** Searchable notes with their links, counted in both directions, inside the vault only. */
export interface LinkGraph {
  notes: VaultFile[];
  /** Undirected neighbours of each note. */
  neighbours: Map<string, Set<string>>;
}

export interface GraphCluster {
  /** 1-based, in size order; the number the map and overview show. */
  number: number;
  hub: string;
  members: string[];
}

export interface GraphAnalysis {
  hubs: { path: string; incomingLinks: number }[];
  clusters: GraphCluster[];
  /** Note path → its cluster number, for notes in a cluster of two or more. */
  clusterOf: Map<string, number>;
  bridges: { path: string; clusters: number[] }[];
  orphans: string[];
  /** Number of links between each pair of clusters ("a-b", a < b). */
  crossLinks: Map<string, number>;
  graph: LinkGraph;
}

/**
 * The link graph of searchable notes. Links from Mesa's notes and the configuration folder are ignored, as in the
 * vault map, and so are links whose target is not a searchable markdown note (attachments, canvases).
 */
export function buildLinkGraph(
  files: VaultFile[],
  links: Record<string, Record<string, number>>,
  managedRoot: string,
  configDir: string,
): LinkGraph {
  const notes = files.filter((file) =>
    isVaultSearchable(file.path, managedRoot, configDir),
  );
  const known = new Set(notes.map((note) => note.path));
  const neighbours = new Map<string, Set<string>>(
    notes.map((note) => [note.path, new Set<string>()]),
  );
  for (const [source, targets] of Object.entries(links)) {
    if (!known.has(source)) continue;
    for (const target of Object.keys(targets)) {
      if (target === source || !known.has(target)) continue;
      neighbours.get(source)!.add(target);
      neighbours.get(target)!.add(source);
    }
  }
  return { notes, neighbours };
}

/** Weighted undirected graph on 0..n-1; `self[i]` is the weight of links inside node i (after merging). */
interface WeightedGraph {
  adjacency: Map<number, number>[];
  self: number[];
}

/**
 * One Louvain level: each node moves to the neighbouring group that raises modularity most, until nothing moves.
 * Nodes are visited in index order and ties keep the current group, then the lower group number, so it is deterministic.
 */
function louvainLevel(graph: WeightedGraph): number[] {
  const n = graph.adjacency.length;
  const strength = graph.adjacency.map(
    (around, i) =>
      [...around.values()].reduce((sum, w) => sum + w, 0) + 2 * graph.self[i]!,
  );
  const twiceTotal = strength.reduce((sum, k) => sum + k, 0);
  const group = strength.map((_, i) => i);
  const groupStrength = [...strength];
  if (twiceTotal === 0) return group;
  for (let round = 0; round < LOUVAIN_ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const own = group[i]!;
      const ki = strength[i]!;
      const toGroup = new Map<number, number>();
      for (const [j, w] of graph.adjacency[i]!)
        toGroup.set(group[j]!, (toGroup.get(group[j]!) ?? 0) + w);
      groupStrength[own]! -= ki;
      const gain = (g: number) =>
        (toGroup.get(g) ?? 0) - (groupStrength[g]! * ki) / twiceTotal;
      let best = own;
      let bestGain = gain(own);
      for (const g of [...toGroup.keys()].sort((a, b) => a - b)) {
        const value = gain(g);
        if (value > bestGain + 1e-12) {
          best = g;
          bestGain = value;
        }
      }
      groupStrength[best]! += ki;
      if (best !== own) {
        group[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return group;
}

/**
 * Groups notes that link to each other with the Louvain method (modularity): densely linked notes end up together,
 * and an index or log note that links to everything does not pull the whole vault into one group the way simple
 * label spreading did. The same vault always gives the same clusters. Notes with no links stay on their own and are
 * reported as orphans instead. Returns each note's group label (the group's first path).
 */
function labelClusters(graph: LinkGraph): Map<string, string> {
  const paths = graph.notes.map((note) => note.path).sort();
  const index = new Map(paths.map((path, i) => [path, i]));
  let level: WeightedGraph = {
    adjacency: paths.map((path) => {
      const around = new Map<number, number>();
      for (const other of graph.neighbours.get(path) ?? []) {
        const j = index.get(other);
        if (j !== undefined) around.set(j, 1);
      }
      return around;
    }),
    self: paths.map(() => 0),
  };
  // Which level-node each note belongs to.
  let membership = paths.map((_, i) => i);
  for (let depth = 0; depth < LOUVAIN_LEVELS; depth++) {
    const group = louvainLevel(level);
    const renumber = new Map<number, number>();
    for (const g of group) if (!renumber.has(g)) renumber.set(g, renumber.size);
    if (renumber.size === level.adjacency.length) break;
    membership = membership.map((node) => renumber.get(group[node]!)!);
    const adjacency = [...renumber.keys()].map(() => new Map<number, number>());
    const self = [...renumber.keys()].map(() => 0);
    level.adjacency.forEach((around, i) => {
      const a = renumber.get(group[i]!)!;
      self[a]! += level.self[i]!;
      for (const [j, w] of around) {
        const b = renumber.get(group[j]!)!;
        if (a === b) self[a]! += w / 2;
        else adjacency[a]!.set(b, (adjacency[a]!.get(b) ?? 0) + w);
      }
    });
    level = { adjacency, self };
  }
  const first = new Map<number, string>();
  paths.forEach((path, i) => {
    if (!first.has(membership[i]!)) first.set(membership[i]!, path);
  });
  return new Map(paths.map((path, i) => [path, first.get(membership[i]!)!]));
}

const degree = (graph: LinkGraph, path: string) =>
  graph.neighbours.get(path)?.size ?? 0;

const byDegreeThenPath = (graph: LinkGraph) => (a: string, b: string) =>
  degree(graph, b) - degree(graph, a) || a.localeCompare(b);

/**
 * Hubs, clusters, bridges and orphans from the link graph. Pure: the same vault always gives the same result.
 * Clusters are named by their most connected note (the hub), and a cluster with one note is not a cluster.
 */
export function analyseLinkGraph(graph: LinkGraph): GraphAnalysis {
  const hubs = graph.notes
    .filter((note) => note.incomingLinks > 0)
    .sort(
      (a, b) =>
        b.incomingLinks - a.incomingLinks || a.path.localeCompare(b.path),
    )
    .slice(0, GRAPH_MAP_LIMITS.hubs)
    .map((note) => ({ path: note.path, incomingLinks: note.incomingLinks }));

  const labels = labelClusters(graph);
  const groups = new Map<string, string[]>();
  for (const [path, label] of labels) {
    if (degree(graph, path) === 0) continue;
    groups.set(label, [...(groups.get(label) ?? []), path]);
  }
  const sized = [...groups.values()]
    .filter((members) => members.length >= 2)
    .map((members) => [...members].sort(byDegreeThenPath(graph)))
    .sort(
      (a, b) => b.length - a.length || byDegreeThenPath(graph)(a[0]!, b[0]!),
    );
  const clusters: GraphCluster[] = sized.map((members, index) => ({
    number: index + 1,
    hub: members[0]!,
    members,
  }));
  const clusterOf = new Map<string, number>();
  for (const cluster of clusters)
    for (const member of cluster.members) clusterOf.set(member, cluster.number);

  const bridges: GraphAnalysis['bridges'] = [];
  const crossLinks = new Map<string, number>();
  for (const note of graph.notes) {
    const own = clusterOf.get(note.path);
    const around = [...graph.neighbours.get(note.path)!];
    const seen = new Set<number>(own !== undefined ? [own] : []);
    for (const other of around) {
      const number = clusterOf.get(other);
      if (number !== undefined) seen.add(number);
      if (own !== undefined && number !== undefined && number !== own) {
        const key = `${Math.min(own, number)}-${Math.max(own, number)}`;
        crossLinks.set(key, (crossLinks.get(key) ?? 0) + 1);
      }
    }
    if (seen.size >= 2)
      bridges.push({
        path: note.path,
        clusters: [...seen].sort((a, b) => a - b),
      });
  }
  // Cross-cluster links were counted from both ends; halve them so each link counts once.
  for (const [key, count] of crossLinks) crossLinks.set(key, count / 2);

  bridges.sort(
    (a, b) =>
      b.clusters.length - a.clusters.length || a.path.localeCompare(b.path),
  );
  const orphans = graph.notes
    .filter((note) => degree(graph, note.path) === 0)
    .map((note) => note.path)
    .sort();

  return {
    hubs,
    clusters,
    clusterOf,
    bridges: bridges.slice(0, GRAPH_MAP_LIMITS.bridges),
    orphans,
    crossLinks,
    graph,
  };
}

/**
 * The graph map as Markdown: hubs, clusters, bridges and orphans, as plain backticked paths (no wikilinks, so the map
 * does not add links to the graph). Size-capped like the vault map. An optional AI section is appended as given.
 */
export function renderGraphMap(
  analysis: GraphAnalysis,
  aiSection: string[] = [],
): string {
  const header = [
    '# Graph map',
    '',
    ...dontDeleteCallout(false),
    '',
    'Built by Mesa from your links, with no AI. Agents read it first, start from the hub or cluster that fits the task, and open only those notes. Written only when it changes.',
  ].join('\n');
  const sections: string[][] = [];
  sections.push([
    '## Hubs (most linked)',
    ...(analysis.hubs.length
      ? analysis.hubs.map(
          (hub) => `- \`${hub.path}\` · ${hub.incomingLinks} incoming`,
        )
      : ['(none yet)']),
  ]);
  const clusterLines: string[] = [
    '## Clusters (notes that link to each other)',
  ];
  if (analysis.clusters.length === 0) clusterLines.push('(none yet)');
  for (const cluster of analysis.clusters.slice(0, GRAPH_MAP_LIMITS.clusters)) {
    const folder = folderOf(cluster.hub);
    clusterLines.push(
      `### Cluster ${cluster.number}: \`${cluster.hub}\` (folder ${folder}) · ${cluster.members.length} notes`,
    );
    for (const member of cluster.members.slice(
      0,
      GRAPH_MAP_LIMITS.membersPerCluster,
    ))
      clusterLines.push(`- \`${member}\``);
    const more = cluster.members.length - GRAPH_MAP_LIMITS.membersPerCluster;
    if (more > 0) clusterLines.push(`- … and ${more} more`);
  }
  const hidden = analysis.clusters.length - GRAPH_MAP_LIMITS.clusters;
  if (hidden > 0)
    clusterLines.push(`… ${hidden} more clusters are not listed here.`);
  sections.push(clusterLines);
  sections.push([
    '## Bridges (notes that join clusters)',
    ...(analysis.bridges.length
      ? analysis.bridges.map(
          (bridge) =>
            `- \`${bridge.path}\` · joins clusters ${bridge.clusters.join(', ')}`,
        )
      : ['(none yet)']),
  ]);
  const orphanLines = analysis.orphans
    .slice(0, GRAPH_MAP_LIMITS.orphans)
    .map((path) => `- \`${path}\``);
  if (analysis.orphans.length > GRAPH_MAP_LIMITS.orphans)
    orphanLines.push(
      `- … and ${analysis.orphans.length - GRAPH_MAP_LIMITS.orphans} more`,
    );
  sections.push([
    '## Orphans (no links)',
    ...(orphanLines.length ? orphanLines : ['(none)']),
  ]);
  if (aiSection.length > 0) sections.push(aiSection);

  const blocks: string[] = [];
  let words = wordCount(header);
  for (const section of sections) {
    const text = section.join('\n');
    if (words + wordCount(text) > GRAPH_MAP_LIMITS.maxWords) {
      blocks.push('… the rest is not listed here to keep the map small.');
      break;
    }
    words += wordCount(text);
    blocks.push(text);
  }
  return [header, ...blocks].join('\n\n') + '\n';
}

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(vault root)';

/** Writes the graph map note, but only when its content changed, so an unchanged vault is not saved again. */
export async function syncGraphMap(
  store: Store,
  root: string,
  body: string,
): Promise<void> {
  const path = `${root}/${GRAPH_MAP_NAME}`;
  const previous = (await store.loadNote(path))?.body ?? '';
  if (body === previous) return;
  const frontmatter = { agenthq: 'graph-map' };
  if (await store.exists(path)) await store.saveNote(path, frontmatter, body);
  else await store.createNote(path, frontmatter, body);
}
