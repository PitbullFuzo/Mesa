import {
  agentFrontmatterSchema,
  type Agent,
  type AgentCollection,
} from './model';

import { FULL_PERMISSION_WARNING } from './permissions';

export interface NoteDocument {
  path: string;
  name: string;
  frontmatter: unknown;
  body: string;
}

function linkTarget(link: string): string {
  return (
    link
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .split('|')[0]
      ?.split('#')[0]
      ?.trim() ?? ''
  );
}

export function parseAgentNotes(
  notes: NoteDocument[],
  resolveLink: (link: string, sourcePath: string) => string | null,
): AgentCollection {
  const agents: Agent[] = [];
  const invalidAgents: AgentCollection['invalidAgents'] = [];
  const candidates = notes.filter((note) => {
    const fm = note.frontmatter;
    return (
      /(?:^|\/)Agents\//.test(note.path) ||
      (typeof fm === 'object' &&
        fm !== null &&
        'agenthq' in fm &&
        fm.agenthq === 'agent')
    );
  });
  const valid = candidates.flatMap((note) => {
    const parsed = agentFrontmatterSchema.safeParse(note.frontmatter);
    if (!parsed.success) {
      invalidAgents.push({
        path: note.path,
        name: note.name,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
      return [];
    }
    return [{ note, data: parsed.data }];
  });
  const unique = valid.filter(({ note, data }) => {
    if (valid.filter((entry) => entry.data.id === data.id).length === 1)
      return true;
    invalidAgents.push({
      path: note.path,
      name: note.name,
      reason: `Duplicate agent id: ${data.id}`,
    });
    return false;
  });
  const byPath = new Map(unique.map((entry) => [entry.note.path, entry]));
  for (const { note, data } of unique) {
    const warnings: string[] = [];
    if (data.permission === 'full') warnings.push(FULL_PERMISSION_WARNING);
    const agentReference = (
      link: string | null,
      relation: string,
    ): string | null => {
      if (link === null) return null;
      try {
        const path = resolveLink(linkTarget(link), note.path);
        const destination = path === null ? undefined : byPath.get(path);
        if (destination) return destination.data.id;
      } catch {
        // An unavailable resolver has the same snapshot fallback as a missing note.
      }
      warnings.push(`${relation} ${link} is missing or invalid`);
      return null;
    };
    const skills = data.skills.flatMap((link) => {
      try {
        const path = resolveLink(linkTarget(link), note.path);
        if (path !== null) return [path];
      } catch {
        // Skip only this skill if resolution is unavailable.
      }
      warnings.push(`Skill ${link} is missing or invalid`);
      return [];
    });
    agents.push({
      ...data,
      path: note.path,
      name: note.name,
      reportsTo: agentReference(data.reportsTo, 'Manager'),
      verifier: agentReference(data.verifier, 'Verifier'),
      skills,
      instructions: note.body,
      warnings,
    });
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cycleMembers = agents.filter((agent) => {
    const seen = new Set<string>([agent.id]);
    let current = agent.reportsTo;
    while (current !== null) {
      if (seen.has(current)) return current === agent.id;
      seen.add(current);
      current = byId.get(current)?.reportsTo ?? null;
    }
    return false;
  });
  // Detect all cycle members before clearing edges; incoming reports remain valid.
  for (const agent of cycleMembers) {
    agent.reportsTo = null;
    agent.warnings.push('Cycle in reportsTo links');
  }
  return { agents, invalidAgents };
}

/** The description from a note's frontmatter, when it has a text one. */
export function frontmatterDescription(
  frontmatter: unknown,
): string | undefined {
  const value = (frontmatter as { description?: unknown } | null)?.description;
  return typeof value === 'string' ? value : undefined;
}
