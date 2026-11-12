import type { Agent, Skill } from './model';
import {
  existingNoteNames,
  noteDestinationsSection,
  noteSkillText,
  type NoteType,
} from './noteTypes';
import type { Store } from './store';

/** The prompt section for an agent's note destinations: the note skill per type and the notes already there. */
export async function buildDestinationsSection(
  store: Store,
  types: NoteType[],
  skills: Skill[],
  vaultBasePath: string | undefined,
): Promise<string> {
  return noteDestinationsSection(
    await Promise.all(
      types.map(async (type) => ({
        type,
        skill: noteSkillText(type, skills),
        existing: await existingNoteNames(store, type.folder),
      })),
    ),
    // Agents run in their Work folder, so they need the full path of each destination.
    vaultBasePath,
  );
}

/** The names of the agents working right now that may write a note in this path's destination. */
export function agentsWritingTo(
  path: string,
  noteTypes: NoteType[],
  states: { status: string; agent: Agent }[],
): string[] {
  const types = noteTypes.filter(
    (type) =>
      type.enabled &&
      path.startsWith(`${type.folder.trim().replace(/\/+$/, '')}/`),
  );
  return states
    .filter(
      (state) =>
        state.status === 'working' &&
        types.some((type) => state.agent.noteTypes?.includes(type.id)),
    )
    .map((state) => state.agent.name);
}
