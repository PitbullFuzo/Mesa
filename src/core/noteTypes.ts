import { z } from 'zod';
import { outputFolderProblem } from './folders';
import type { Agent } from './model';
import type { Store } from './store';

/**
 * Note destinations: a note type (meeting, research, wiki, permanent…) maps to a folder in the owner's real vault.
 * An agent with a type ticked may write that folder, and only that folder, without "Read & write vault".
 */
export const noteTypeSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().trim().min(1),
  folder: z.string().trim(),
  enabled: z.boolean().catch(true),
});
export type NoteType = z.infer<typeof noteTypeSchema>;

export const DEFAULT_NOTE_TYPES: NoteType[] = [
  { id: 'meeting', label: 'Meeting notes', folder: 'Meetings', enabled: true },
  { id: 'research', label: 'Research', folder: 'Research', enabled: true },
  { id: 'wiki', label: 'Wiki', folder: 'Wiki', enabled: true },
  {
    id: 'permanent',
    label: 'Permanent notes',
    folder: 'Permanent',
    enabled: true,
  },
];

const clean = (folder: string) =>
  folder.trim().replace(/\\/g, '/').replace(/\/+$/, '');

/** Why this type's folder cannot be used, or undefined: the same check as a project's Output folder, but required. */
export function noteTypeProblem(
  type: Pick<NoteType, 'folder'>,
  managedRoot: string,
  configDir: string,
): string | undefined {
  if (clean(type.folder) === '') return 'Choose a folder in your vault.';
  return outputFolderProblem(type.folder, managedRoot, configDir);
}

/** A new custom type from a label and folder, with an id that is not taken. */
export function newNoteType(
  label: string,
  folder: string,
  existing: NoteType[],
): NoteType {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'notes';
  let id = base;
  for (let n = 2; existing.some((type) => type.id === id); n++)
    id = `${base}-${n}`;
  return { id, label: label.trim(), folder: clean(folder), enabled: true };
}

/** The types this agent has ticked that are on and have a usable folder. */
export function agentNoteTypes(
  agent: Pick<Agent, 'noteTypes'>,
  types: NoteType[],
  managedRoot: string,
  configDir: string,
): NoteType[] {
  const ticked = agent.noteTypes ?? [];
  return types.filter(
    (type) =>
      type.enabled &&
      ticked.includes(type.id) &&
      noteTypeProblem(type, managedRoot, configDir) === undefined,
  );
}

/** The folders those types make writable for a run. */
export function destinationFolders(types: NoteType[]): string[] {
  return [...new Set(types.map((type) => clean(type.folder)))];
}

const COMMON = [
  'Start every note with this frontmatter (fill it in):',
  '```yaml',
  '---',
  'type: TYPE',
  'date: YYYY-MM-DD',
  'tags: []',
  'SOURCEFIELD',
  '---',
  '```',
  'Name the file NAMING.',
  'Link with [[double brackets]]: people, projects and related notes that already exist, so the note joins the graph. Never invent a note to link to.',
];
const template = (type: string, source: string, naming: string) =>
  COMMON.join('\n')
    .replace('TYPE', type)
    .replace('SOURCEFIELD', source)
    .replace('NAMING', naming);

/** The built-in note skills, written once to the Skills folder where the owner can edit them. */
export const BUILTIN_NOTE_SKILLS: Record<
  string,
  { name: string; description: string; body: string }
> = {
  meeting: {
    name: 'Meeting notes',
    description: 'How to write a meeting note: attendees, decisions, actions.',
    body: [
      template(
        'meeting',
        'attendees: [name, name]',
        '`YYYY-MM-DD Topic.md` (the meeting date, then the topic)',
      ),
      'Sections: Attendees (link each person), Agenda, Decisions (one line each), Action items (`- [ ] task: owner, due date`, owner linked), Notes.',
      'Link the project the meeting belongs to, and earlier meetings on the same topic.',
    ].join('\n\n'),
  },
  research: {
    name: 'Research',
    description: 'How to write a research note with sources.',
    body: [
      template('research', 'source: main link', '`Topic - short question.md`'),
      'Sections: Question, Findings (short, in your own words), Sources (every source as a link with what it says), Open questions.',
      'Link related notes and the project the research is for. Say what you could not verify.',
    ].join('\n\n'),
  },
  wiki: {
    name: 'Wiki',
    description: 'How to write wiki pages: one topic per page, no duplicates.',
    body: [
      template(
        'wiki',
        'source: where this comes from',
        '`Topic.md` (the topic name only)',
      ),
      'One topic per page. **Search the Wiki folder first**: if a page on the topic exists, update it instead of creating another. Keep it short and factual; add what changed and where it came from.',
      'Link related wiki pages and people or projects involved.',
    ].join('\n\n'),
  },
  permanent: {
    name: 'Permanent notes',
    description:
      'How to write permanent (Zettelkasten) notes: one idea, own words, links.',
    body: [
      template(
        'permanent',
        'source: where the idea came from',
        '`A sentence that states the idea.md`',
      ),
      'One idea per note, written in your own words (no copied passages). Say why it matters in one or two short paragraphs.',
      'End with a Links section: at least two related permanent notes or topics, each with a few words on how they relate.',
    ].join('\n\n'),
  },
};

const GENERIC_SKILL = (label: string) =>
  [
    template('NOTETYPE', '', '`YYYY-MM-DD Title.md`').replace(
      'NOTETYPE',
      label.toLowerCase(),
    ),
    'Keep each note on one topic. Link related notes with [[ ]].',
  ].join('\n\n');

/** The skill text for a type: the owner's edited note when it exists, else the built-in text. */
export function noteSkillText(
  type: NoteType,
  skills: { name: string; body: string }[],
): string {
  const builtin = BUILTIN_NOTE_SKILLS[type.id];
  if (!builtin) return GENERIC_SKILL(type.label);
  return (
    skills.find((skill) => skill.name === builtin.name)?.body ?? builtin.body
  );
}

/** The short instruction for an agent with destinations: where it may write, the skill per type, what exists. */
export function noteDestinationsSection(
  entries: { type: NoteType; skill: string; existing: string[] }[],
  vaultBase = '',
): string {
  if (entries.length === 0) return '';
  return [
    '## Where to save notes',
    'You may create and edit notes only in these folders of the vault, and nowhere else in the vault:',
    ...entries.map(
      ({ type }) =>
        `- ${type.label} → \`${clean(type.folder)}/\`${vaultBase ? ` (full path: \`${clean(vaultBase)}/${clean(type.folder)}\`)` : ''}`,
    ),
    'For each note, follow the matching note skill below. Look at what already exists first, link to those notes with [[ ]], and update an existing note instead of making a duplicate.',
    ...entries.map(({ type, skill, existing }) =>
      [
        `### Note skill: ${type.label}`,
        skill,
        existing.length
          ? `Existing notes in \`${clean(type.folder)}/\` (link to these by name): ${existing.map((name) => `[[${name}]]`).join(', ')}`
          : `\`${clean(type.folder)}/\` has no notes yet.`,
      ].join('\n\n'),
    ),
  ].join('\n\n');
}

/** Note names under a folder, for "link to what exists" (capped). */
export async function existingNoteNames(
  store: Pick<Store, 'loadNotesUnder'>,
  folder: string,
  cap = 40,
): Promise<string[]> {
  const notes = await store.loadNotesUnder(clean(folder));
  return notes
    .map((note) => note.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, cap);
}

/** Writes the built-in note skills that are missing. Existing notes, edited or not, are never touched. */
export async function ensureNoteSkills(
  store: Pick<Store, 'exists' | 'createNote'>,
  root: string,
): Promise<void> {
  for (const skill of Object.values(BUILTIN_NOTE_SKILLS)) {
    const path = `${root}/Skills/${skill.name}.md`;
    if (!(await store.exists(path)))
      await store.createNote(
        path,
        { description: skill.description },
        skill.body,
      );
  }
}
