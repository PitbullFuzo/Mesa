import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { GUIDE_BODY } from '../src/core/guide';
import { MemoryStore } from '../src/core/memoryStore';
import {
  agentNoteTypes,
  BUILTIN_NOTE_SKILLS,
  DEFAULT_NOTE_TYPES,
  destinationFolders,
  ensureNoteSkills,
  newNoteType,
  noteDestinationsSection,
  noteTypeProblem,
  type NoteType,
} from '../src/core/noteTypes';
import { parseObiProposals } from '../src/core/obi';
import { loadSettings } from '../src/core/settings';
import type { RunRequest, RuntimeAdapter } from '../src/core/runtimes/types';

const ROOT = 'Mesa';
const CONFIG = '.obsidian';
const meeting = DEFAULT_NOTE_TYPES[0]!;

describe('note destination folders', () => {
  it('accepts plain vault folders', () => {
    for (const type of DEFAULT_NOTE_TYPES)
      expect(noteTypeProblem(type, ROOT, CONFIG)).toBeUndefined();
    expect(
      noteTypeProblem({ folder: 'Notes/Meetings/' }, ROOT, CONFIG),
    ).toBeUndefined();
  });
  it.each([
    ['', /Choose a folder/],
    ['  ', /Choose a folder/],
    ['/etc', /inside the vault/],
    ['C:/x', /inside the vault/],
    ['../x', /plain folder/],
    ['a/../b', /plain folder/],
    ['.obsidian', /configuration folder/],
    ['.obsidian/plugins', /configuration folder/],
    ['Mesa/Agents', /protected/],
    ['Mesa/Skills', /protected/],
    ['Mesa', /protected/],
  ])('refuses %j', (folder, reason) => {
    expect(noteTypeProblem({ folder }, ROOT, CONFIG)).toMatch(reason);
  });
  it('adds a custom type with a free id', () => {
    const added = newNoteType('Recipes', 'Food/Recipes/', DEFAULT_NOTE_TYPES);
    expect(added).toEqual({
      id: 'recipes',
      label: 'Recipes',
      folder: 'Food/Recipes',
      enabled: true,
    });
    expect(newNoteType('Wiki', 'W2', DEFAULT_NOTE_TYPES).id).toBe('wiki-2');
  });
});

describe('which destinations an agent gets', () => {
  const types: NoteType[] = [
    ...DEFAULT_NOTE_TYPES.slice(0, 3),
    { id: 'bad', label: 'Bad', folder: 'Mesa/Agents', enabled: true },
  ];
  it('none by default', () => {
    expect(agentNoteTypes({}, types, ROOT, CONFIG)).toEqual([]);
    expect(agentNoteTypes({ noteTypes: [] }, types, ROOT, CONFIG)).toEqual([]);
  });
  it('only ticked types that are on and have a usable folder', () => {
    const agent = { noteTypes: ['meeting', 'wiki', 'bad', 'gone'] };
    expect(agentNoteTypes(agent, types, ROOT, CONFIG).map((t) => t.id)).toEqual(
      ['meeting', 'wiki'],
    );
    const off = types.map((t) =>
      t.id === 'wiki' ? { ...t, enabled: false } : t,
    );
    expect(agentNoteTypes(agent, off, ROOT, CONFIG).map((t) => t.id)).toEqual([
      'meeting',
    ]);
    expect(
      destinationFolders(agentNoteTypes(agent, types, ROOT, CONFIG)),
    ).toEqual(['Meetings', 'Wiki']);
  });
});

describe('settings', () => {
  it('start with the four defaults, all on, and keep the owner’s changes', () => {
    expect(loadSettings({}).noteTypes).toEqual(DEFAULT_NOTE_TYPES);
    const custom = [
      {
        id: 'meeting',
        label: 'Meeting notes',
        folder: 'Work/Meetings',
        enabled: false,
      },
    ];
    expect(
      loadSettings(JSON.parse(JSON.stringify({ noteTypes: custom }))).noteTypes,
    ).toEqual(custom);
    expect(loadSettings({ noteTypes: 'garbage' }).noteTypes).toEqual(
      DEFAULT_NOTE_TYPES,
    );
  });
});

describe('built-in note skills', () => {
  it('are written once as ordinary notes and never overwritten after the owner edits them', async () => {
    const store = new MemoryStore(ROOT);
    await ensureNoteSkills(store, ROOT);
    const names = (await store.loadSkills()).map((s) => s.name).sort();
    expect(names).toEqual([
      'Meeting notes',
      'Permanent notes',
      'Research',
      'Wiki',
    ]);
    await store.saveNote(`${ROOT}/Skills/Wiki.md`, {}, 'My own wiki rules');
    await ensureNoteSkills(store, ROOT);
    expect(
      (await store.loadSkills()).find((s) => s.name === 'Wiki')!.body,
    ).toBe('My own wiki rules');
  });
  it('carry the rules: template, naming, links, and each type’s own rule', () => {
    for (const skill of Object.values(BUILTIN_NOTE_SKILLS)) {
      expect(skill.body).toContain('type:');
      expect(skill.body).toContain('date:');
      expect(skill.body).toContain('tags:');
      expect(skill.body).toContain('Name the file');
      expect(skill.body).toContain('[[double brackets]]');
    }
    expect(BUILTIN_NOTE_SKILLS.meeting!.body).toMatch(/attendees/i);
    expect(BUILTIN_NOTE_SKILLS.meeting!.body).toMatch(/Decisions/);
    expect(BUILTIN_NOTE_SKILLS.meeting!.body).toMatch(/Action items.*owner/s);
    expect(BUILTIN_NOTE_SKILLS.research!.body).toMatch(/Sources/);
    expect(BUILTIN_NOTE_SKILLS.wiki!.body).toMatch(
      /Search the Wiki folder first/,
    );
    expect(BUILTIN_NOTE_SKILLS.wiki!.body).toMatch(
      /instead of creating another/,
    );
    expect(BUILTIN_NOTE_SKILLS.permanent!.body).toMatch(/One idea per note/);
    expect(BUILTIN_NOTE_SKILLS.permanent!.body).toMatch(/own words/);
  });
});

describe('the instruction an agent gets', () => {
  it('is empty without destinations', () => {
    expect(noteDestinationsSection([])).toBe('');
  });
  it('lists the folders, the skill and the notes that already exist to link to', () => {
    const text = noteDestinationsSection([
      { type: meeting, skill: 'SKILL TEXT', existing: ['2026-10-01 Kickoff'] },
      { type: DEFAULT_NOTE_TYPES[2]!, skill: 'WIKI SKILL', existing: [] },
    ]);
    expect(text).toContain('only in these folders');
    expect(text).toContain('Meeting notes → `Meetings/`');
    expect(text).toContain('SKILL TEXT');
    expect(text).toContain('[[2026-10-01 Kickoff]]');
    expect(text).toContain('`Wiki/` has no notes yet.');
  });
});

/** A service with a runtime that records what it was asked to run. */
async function service(options: {
  noteTypes?: NoteType[];
  ticked: string[];
  hold?: boolean;
}) {
  const store = new MemoryStore(ROOT);
  const id = await store.createAgent('Scribe');
  await store.patchAgent(id, {
    runtime: 'opencode',
    permission: 'edit',
    noteTypes: options.ticked,
  });
  await store.createNote('Meetings/2026-10-01 Kickoff.md', {}, 'old');
  await ensureNoteSkills(store, ROOT);
  const requests: RunRequest[] = [];
  let release: () => void = () => {};
  const adapter: RuntimeAdapter = {
    id: 'opencode',
    displayName: 'OpenCode',
    detect: async () => ({ available: true }),
    start: (request, onEvent) => {
      requests.push(request);
      const finish = () =>
        onEvent({ type: 'done', text: 'ok', isError: false, costUsd: 0 });
      if (options.hold) release = finish;
      else finish();
      return { stop: async () => {} };
    },
  };
  const chat = new ChatService({
    store,
    adapters: [adapter],
    settings: () => ({
      maxParallelRuns: 1,
      allowedFolders: [],
      noteTypes: options.noteTypes ?? DEFAULT_NOTE_TYPES,
    }),
    vaultBasePath: '/vault',
    managedRoot: ROOT,
    configDir: CONFIG,
    memoryDelayMs: 60_000,
  });
  await chat.initialize();
  return { chat, id, requests, store, release: () => release() };
}

describe('a run for an agent with a note type ticked', () => {
  it('may write that folder, and the instruction names it with the skill and the existing notes', async () => {
    const s = await service({ ticked: ['meeting'] });
    await s.chat.send(s.id, 'write up the call');
    const run = s.requests[0]!;
    expect(run.extraDirs).toContain('/vault/Meetings');
    expect(run.extraDirs).not.toContain('/vault/Research');
    expect(run.extraDirs).not.toContain('/vault');
    expect(run.readDirs).toEqual([]);
    expect(run.systemPrompt).toContain('## Where to save notes');
    expect(run.systemPrompt).toContain('Meeting notes → `Meetings/`');
    expect(run.systemPrompt).toContain('(full path: `/vault/Meetings`)');
    expect(run.systemPrompt).toContain('Action items');
    expect(run.systemPrompt).toContain('[[2026-10-01 Kickoff]]');
    expect(run.systemPrompt).not.toContain('Research →');
  });
  it('an agent without it can write nowhere there and is told nothing about it', async () => {
    const s = await service({ ticked: [] });
    await s.chat.send(s.id, 'go');
    const run = s.requests[0]!;
    expect(run.extraDirs).not.toContain('/vault/Meetings');
    expect(run.systemPrompt).not.toContain('Where to save notes');
  });
  it('a type that is off, or has an unusable folder, gives nothing', async () => {
    const off = await service({
      ticked: ['meeting'],
      noteTypes: DEFAULT_NOTE_TYPES.map((t) => ({ ...t, enabled: false })),
    });
    await off.chat.send(off.id, 'go');
    expect(off.requests[0]!.extraDirs).not.toContain('/vault/Meetings');
    const bad = await service({
      ticked: ['meeting'],
      noteTypes: [{ ...meeting, folder: 'Mesa/Agents' }],
    });
    await bad.chat.send(bad.id, 'go');
    expect((bad.requests[0]!.extraDirs ?? []).join()).not.toContain('Agents');
    expect(bad.requests[0]!.systemPrompt).not.toContain('Where to save notes');
  });
  it('Activity can name the working agent that may write a path, and nobody else', async () => {
    const s = await service({ ticked: ['meeting'], hold: true });
    const done = s.chat.send(s.id, 'go');
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    expect(s.chat.writersFor('Meetings/new.md')).toEqual(['Scribe']);
    expect(s.chat.writersFor('Research/new.md')).toEqual([]);
    expect(s.chat.writersFor('Elsewhere/new.md')).toEqual([]);
    s.release();
    await done;
    expect(s.chat.writersFor('Meetings/new.md')).toEqual([]);
  });
});

describe('Obi', () => {
  it('cannot choose where an agent writes notes', () => {
    const reply =
      '```agenthq-admin\n{"actions":[{"type":"updateAgent","id":"coder","noteTypes":["meeting"]}]}\n```';
    const { proposals, problems } = parseObiProposals(reply, {
      agents: [],
      groups: [],
    });
    expect(proposals).toEqual([]);
    expect(problems.join(' ')).toContain(
      'Obi cannot choose where an agent writes notes',
    );
  });
});

describe('the guide', () => {
  it('explains note destinations and that they start empty', () => {
    expect(GUIDE_BODY).toContain('Note destinations');
    expect(GUIDE_BODY).toContain(
      'Agents have no note destinations until you tick them',
    );
  });
});
