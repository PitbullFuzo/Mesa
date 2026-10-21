import type { Agent, AgentCollection, Group, Skill } from './model';
import type { NoteDocument } from './notes';
import type { AgentSetupPatch } from './setup';

export interface Store {
  readonly root: string;
  exists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  createNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void>;
  loadAgents(): Promise<AgentCollection>;
  saveAgent(agent: Agent): Promise<void>;
  patchAgent(id: string, patch: AgentSetupPatch): Promise<void>;
  setManager(id: string, managerId: string | null): Promise<void>;
  createAgent(name: string): Promise<string>;
  deleteAgent(id: string): Promise<void>;
  loadGroups(): Promise<Group[]>;
  saveGroups(groups: Group[]): Promise<void>;
  loadSkills(): Promise<Skill[]>;
  loadLayout(): Promise<Record<string, { x: number; y: number }>>;
  /** Pinned agent ids, in pin order. */
  loadPins(): Promise<string[]>;
  savePins(pins: string[]): Promise<void>;
  saveLayout(layout: Record<string, { x: number; y: number }>): Promise<void>;
  loadChats(): Promise<NoteDocument[]>;
  loadProjects(): Promise<NoteDocument[]>;
  /** One note by its full path, or null when there is none. */
  loadNote(path: string): Promise<NoteDocument | null>;
  /** Every note under a folder path, at any depth. */
  loadNotesUnder(folder: string): Promise<NoteDocument[]>;
  /** Moves one chat note to the trash; the caller owns confirmation. */
  trashNote(path: string): Promise<void>;
  loadTasks(): Promise<NoteDocument[]>;
  loadActivity(): Promise<NoteDocument[]>;
  renameNote(path: string, newPath: string): Promise<void>;
  saveNote(
    path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void>;
  /** A plugin-written file that is not a note (the kept graph AI results), or null when it does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
}
