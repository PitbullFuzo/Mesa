import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memoryStore';
import {
  ensureAgentHqFolders,
  initializeStarterTeam,
} from '../src/core/starter';
import { DEFAULT_RUNTIME_ID } from '../src/core/runtimes/ids';

describe('starter team', () => {
  it('creates the exact linked starter fields, folders, licensed skill and welcome note', async () => {
    const store = new MemoryStore('Team');
    expect(await initializeStarterTeam(store, 'Team')).toBe(true);
    expect([...store.folders]).toEqual([
      'Team',
      ...[
        'Agents',
        'Skills',
        'Chats',
        'Tasks',
        'Activity',
        'Projects',
        'Schedules',
        'Work',
        'Attachments',
      ].map((folder) => `Team/${folder}`),
    ]);
    const common = {
      agenthq: 'agent',
      group: 'core',
      runtime: DEFAULT_RUNTIME_ID,
      model: '',
      workdir: '',
      outsideFolders: [],
    };
    expect(store.notes.get('Team/Agents/CEO.md')?.frontmatter).toEqual({
      ...common,
      id: 'ceo',
      role: 'Lead',
      reportsTo: null,
      permission: 'read-only',
      verifier: null,
      skills: [],
    });
    expect(store.notes.get('Team/Agents/Coder.md')?.frontmatter).toEqual({
      ...common,
      id: 'coder',
      role: 'Software engineer',
      reportsTo: '[[CEO]]',
      permission: 'edit',
      verifier: '[[Reviewer]]',
      skills: ['[[karpathy-guidelines]]'],
    });
    expect(store.notes.get('Team/Agents/Reviewer.md')?.frontmatter).toEqual({
      ...common,
      id: 'reviewer',
      role: 'Reviewer',
      reportsTo: '[[CEO]]',
      permission: 'read-only',
      verifier: null,
      skills: [],
    });
    expect(store.notes.get('Team/Welcome.md')?.body).toContain(
      'Click CEO in the AI Graph and tell it what you need.',
    );
    expect(store.notes.get('Team/Welcome.md')?.body).toContain('Settings');
    expect(store.notes.get('Team/Welcome.md')?.body).toContain(
      'Ask an agent about this note',
    );
    expect(await store.loadGroups()).toEqual([
      { id: 'core', name: 'Core team', color: '#7c3aed' },
    ]);
    const skill = (await store.loadSkills())[0];
    for (const text of [
      'Think Before Coding',
      'Simplicity First',
      'Surgical Changes',
      'Goal-Driven Execution',
      'MIT License',
      'Copyright (c) 2025 chrisliu298',
      'Permission is hereby granted',
      'THE SOFTWARE IS PROVIDED "AS IS"',
    ])
      expect(skill?.body).toContain(text);
    expect((await store.loadAgents()).invalidAgents).toEqual([]);
    expect((await store.loadAgents()).agents).toHaveLength(3);
  });
  it('never overwrites an existing root, even if it is empty or a note', async () => {
    const store = new MemoryStore();
    await store.createFolder('Obi-I');
    expect(await initializeStarterTeam(store, 'Obi-I')).toBe(false);
    expect(store.notes.size).toBe(0);
    const noteStore = new MemoryStore();
    await noteStore.createNote('Obi-I', {}, 'User note');
    expect(await initializeStarterTeam(noteStore, 'Obi-I')).toBe(false);
    expect(noteStore.notes.get('Obi-I')?.body).toBe('User note');
  });
  it('is idempotent and leaves user-edited starter notes untouched', async () => {
    const store = new MemoryStore();
    await initializeStarterTeam(store, 'Obi-I');
    await store.saveNote(
      'Obi-I/Agents/CEO.md',
      { user: 'custom' },
      'My instructions',
    );
    const before = structuredClone([...store.notes]);
    expect(await initializeStarterTeam(store, 'Obi-I')).toBe(false);
    expect([...store.notes]).toEqual(before);
  });
});

describe('Obi-I folders on every start', () => {
  it('creates only the missing folders and leaves existing content alone', async () => {
    const store = new MemoryStore('Team');
    await store.createFolder('Team');
    await store.createFolder('Team/Agents');
    await store.createNote('Team/Agents/Mine.md', { id: 'mine' }, 'Mine.');
    await ensureAgentHqFolders(store, 'Team');
    expect(store.folders.has('Team/Projects')).toBe(true);
    expect(store.folders.has('Team/Attachments')).toBe(true);
    expect(store.notes.get('Team/Agents/Mine.md')?.frontmatter).toEqual({
      id: 'mine',
    });
    await expect(ensureAgentHqFolders(store, 'Team')).resolves.toBeUndefined();
  });
});
