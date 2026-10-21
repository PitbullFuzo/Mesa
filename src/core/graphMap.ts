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
const LABEL_ROUNDS = 20;

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
 * The link graph of searchable notes. Links from Obi-I's notes and the configuration folder are ignored, as in the
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

/**
 * Groups notes that link to each other by label propagation: every note starts as its own group and takes the most
 * common group among its neighbours. Ties go to the smaller path, and rounds are capped, so the same vault always
 * gives the same clusters. Notes with no links keep their own label and are reported as orphans instead.
 */
function labelClusters(graph: LinkGraph): Map<string, string> {
  const paths = graph.notes.map((note) => note.path).sort();
  const labels = new Map(paths.map((path) => [path, path]));
  for (let round = 0; round < LABEL_ROUNDS; round++) {
    let changed = false;
    for (const path of paths) {
      const around = [...graph.neighbours.get(path)!];
      if (around.length === 0) continue;
      const counts = new Map<string, number>();
      for (const other of around) {
        const label = labels.get(other)!;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      let best = labels.get(path)!;
      let bestCount = counts.get(best) ?? 0;
      for (const [label, count] of [...counts].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (count > bestCount) {
          best = label;
          bestCount = count;
        }
      }
      if (best !== labels.get(path)) {
        labels.set(path, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
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
    'Built by Obi-I from your links, with no AI. Agents read it first, start from the hub or cluster that fits the task, and open only those notes. Written only when it changes.',
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
