/**
 * Agents end some replies with a fenced JSON block that Mesa acts on (team changes, hand-offs, reviews, memory, vault
 * reorganisation). Mesa reads the raw reply; the chat shows each complete block as a short plain line instead, so a
 * non-developer never sees JSON. A block that cannot be read is left as it is, so a problem stays visible.
 */
const BLOCK =
  /```agenthq-(admin|delegate|verdict|memory|reorg)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*/g;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const listOf = (record: Record<string, unknown>, key: string): unknown[] =>
  Array.isArray(record[key]) ? record[key] : [];

const short = (text: string, limit = 120) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** The plain line for one block, or null when it cannot be read. */
function describe(kind: string, json: string): string | null {
  let data: Record<string, unknown> | null;
  try {
    data = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  if (!data) return null;
  switch (kind) {
    case 'admin': {
      const actions = listOf(data, 'actions');
      return actions.length
        ? `> **Proposed team changes (${actions.length})** — nothing changes until you approve each one.`
        : null;
    }
    case 'delegate': {
      const tasks = listOf(data, 'tasks')
        .map(asRecord)
        .filter((task): task is Record<string, unknown> => !!task);
      if (!tasks.length) return null;
      return [
        `> **Handed to the team (${plural(tasks.length, 'task')})**`,
        ...tasks.map((task) => {
          const to = typeof task.to === 'string' ? task.to : 'an agent';
          const what = typeof task.task === 'string' ? short(task.task) : '';
          return `> - ${to}${what ? `: ${what}` : ''}`;
        }),
      ].join('\n');
    }
    case 'verdict': {
      const verdict = data.verdict;
      if (verdict !== 'pass' && verdict !== 'fail') return null;
      const feedback =
        typeof data.feedback === 'string' ? short(data.feedback, 400) : '';
      return `> **Review: ${verdict === 'pass' ? 'passed' : 'needs changes'}**${feedback ? ` — ${feedback}` : ''}`;
    }
    case 'memory': {
      const memories = listOf(data, 'memories');
      return memories.length
        ? `> **Remembered ${plural(memories.length, 'thing')}** for this project.`
        : null;
    }
    case 'reorg': {
      const moves = listOf(data, 'moves').length;
      const merges = listOf(data, 'merges').length;
      return `> **Proposed vault reorganisation:** ${plural(moves, 'move')}${merges ? ` and ${plural(merges, 'merge')}` : ''}. Review the plan before anything changes.`;
    }
    default:
      return null;
  }
}

/** The reply as the chat shows it: Mesa's action blocks become short plain lines. */
export function readableReply(text: string): string {
  if (!text.includes('```agenthq-')) return text;
  return text.replace(
    BLOCK,
    (whole, kind: string, json: string) => describe(kind, json) ?? whole,
  );
}
