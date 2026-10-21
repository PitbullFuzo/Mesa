/** Slash commands typed at the start of the composer. */
export const SLASH_COMMANDS = [
  {
    name: 'new',
    usage: '/new',
    hint: 'Start a new chat (with a short summary of this one)',
  },
  {
    name: 'fork',
    usage: '/fork',
    hint: 'Fork a new chat from the last message',
  },
  {
    name: 'skill',
    usage: '/skill <name>',
    hint: 'Use a skill for this message',
  },
  {
    name: 'compact',
    usage: '/compact',
    hint: 'Summarise and continue in a new chat',
  },
  {
    name: 'project',
    usage: '/project <name>',
    hint: 'Send this chat under a project',
  },
  { name: 'help', usage: '/help', hint: 'List these commands' },
] as const;

export type SlashName = (typeof SLASH_COMMANDS)[number]['name'];

/** The commands the popup offers: only while the first word is being typed after "/". */
export function slashMatches(draft: string): (typeof SLASH_COMMANDS)[number][] {
  const typing = /^\/([a-z]*)$/i.exec(draft);
  if (!typing) return [];
  const prefix = typing[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export interface SlashCall {
  name: SlashName;
  /** Everything after the command word: a skill or project name, then (for /skill) the message. */
  rest: string;
}

/** A known command at the start of the draft, or null: unknown commands are sent as ordinary text. */
export function parseSlash(draft: string): SlashCall | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(draft.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const known = SLASH_COMMANDS.find((command) => command.name === name);
  return known ? { name: known.name, rest: (match[2] ?? '').trim() } : null;
}

/** Finds a named item whose name starts the text; returns it and the text that follows (longest name wins). */
export function takeNamed<T extends { name: string }>(
  items: T[],
  text: string,
): { item: T; rest: string } | null {
  const lower = text.toLowerCase();
  const found = [...items]
    .sort((a, b) => b.name.length - a.name.length)
    .find((item) => {
      const name = item.name.toLowerCase();
      return lower === name || lower.startsWith(`${name} `);
    });
  return found
    ? { item: found, rest: text.slice(found.name.length).trim() }
    : null;
}

/** The message sent for "/skill <name> <message>": the skill's instructions go with this one message. */
export function skillMessage(
  skill: { name: string; body: string },
  message: string,
): string {
  return `Use the skill "${skill.name}" for this message.\n\n## Skill: ${skill.name}\n${skill.body.trim()}\n\n---\n${message}`;
}

export const SLASH_HELP = SLASH_COMMANDS.map(
  (command) => `${command.usage}: ${command.hint}`,
).join('\n');
