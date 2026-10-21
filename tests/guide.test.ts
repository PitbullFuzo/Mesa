import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import {
  DISCLAIMER,
  GUIDE_BODY,
  GUIDE_SECTIONS,
  GUIDE_VERSION,
  syncGuideNote,
} from '../src/core/guide';
import { MemoryStore } from '../src/core/memoryStore';
import { loadSettings } from '../src/core/settings';
import { obiPrompt } from '../src/core/obi';
import { WorkspaceController } from '../src/obsidian/workspaceController';

vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
}));

const section = (title: string) =>
  GUIDE_SECTIONS.find((entry) => entry.title === title)!.body;

describe('the guide text', () => {
  it('says what you need, with a link for each tool', () => {
    const need = section('What you need');
    expect(need).toContain('https://obsidian.md');
    expect(need).toContain('https://nodejs.org');
    expect(need).toContain('version 0.160.0 or newer');
    expect(need).toContain('1.19.1 or newer');
    expect(need).toContain('Python comes with Hermes');
    expect(need).toContain('No coding languages are needed');
  });

  it('has the sections in order, with plain safety rules', () => {
    expect(GUIDE_SECTIONS.map((section) => section.title)).toEqual([
      'What Obi-I is',
      'What you need',
      'Agents, groups and the CEO',
      'Projects, memory and costs',
      'Schedules and loops',
      'Safety in plain words',
      "What agents can and can't do",
      'Graph map and overview',
    ]);
    const safety = section('Safety in plain words');
    expect(safety).toContain('Work folder');
    expect(safety).toContain('Read & write vault');
    expect(safety).toContain('Codex can read the whole computer');
    expect(safety).toContain('clean profile with no logins');
    expect(safety).toContain('Back up your vault');
  });

  it('says the features that are not built yet are not available', () => {
    const can = section("What agents can and can't do");
    expect(can).toContain(
      'Run programs: only when Run commands is set to Allow freely',
    );
    expect(can).toContain('Google/Gmail is not available yet');
    expect(can).toContain('Microsoft 365 (Outlook mail, calendar, OneDrive)');
    expect(can).toContain(
      'each show an Approve card with the full content first',
    );
  });

  it('keeps the disclaimer text exact', () => {
    expect(DISCLAIMER).toBe(
      "Obi-I lets AI agents read and change files you allow. It is provided as-is, without warranty. We aren't responsible for data loss or AI costs. Please back up your vault before giving agents write access or reorganising notes.",
    );
  });

  it("is in Obi's prompt, so its answers match the tour", () => {
    const prompt = obiPrompt([], []);
    expect(prompt).toContain(GUIDE_BODY);
    expect(prompt).toContain('## Safety in plain words');
  });
});

describe('Guide.md', () => {
  it('is created with the guide version, and left alone when the version matches', async () => {
    const store = new MemoryStore('Obi-I');
    await syncGuideNote(store, 'Obi-I');
    const created = store.notes.get('Obi-I/Guide.md')!;
    expect(created.frontmatter).toMatchObject({ guideVersion: GUIDE_VERSION });
    expect(created.body).toBe(GUIDE_BODY);
    created.body = 'Owner edit that matches the version.';
    await syncGuideNote(store, 'Obi-I');
    expect(store.notes.get('Obi-I/Guide.md')!.body).toBe(
      'Owner edit that matches the version.',
    );
  });

  it('is refreshed when the guide version changes', async () => {
    const store = new MemoryStore('Obi-I');
    await store.createNote(
      'Obi-I/Guide.md',
      { guideVersion: GUIDE_VERSION - 1 },
      'Old text.',
    );
    await syncGuideNote(store, 'Obi-I');
    const refreshed = store.notes.get('Obi-I/Guide.md')!;
    expect(refreshed.body).toBe(GUIDE_BODY);
    expect(refreshed.frontmatter).toMatchObject({
      guideVersion: GUIDE_VERSION,
    });
  });
});

describe('the welcome tour flags', () => {
  it('start unset, so the tour shows on a fresh install', () => {
    const settings = loadSettings({});
    expect(settings.tourDone).toBe(false);
    expect(settings.disclaimerAccepted).toBe(false);
  });

  it('finishing saves both flags; "Maybe later" only hides the tour for this session', async () => {
    const saved: unknown[] = [];
    const workspace = new WorkspaceController(
      {} as App,
      () => {},
      async () => [],
      async (flags) => {
        saved.push(flags);
      },
    );
    workspace.setTourState(false, false);
    workspace.dismissTour();
    expect(workspace.getSnapshot().tourDismissed).toBe(true);
    expect(saved).toEqual([]);

    workspace.restartTour();
    expect(workspace.getSnapshot()).toMatchObject({
      tourDone: false,
      tourDismissed: false,
    });
    await workspace.finishTour();
    expect(saved).toEqual([{ tourDone: true, disclaimerAccepted: true }]);
    expect(workspace.getSnapshot()).toMatchObject({
      tourDone: true,
      disclaimerAccepted: true,
    });
  });

  it('the workspace passes the choice to the vault setting', () => {
    let hidden = false;
    const workspace = new WorkspaceController(
      {} as App,
      () => {},
      async () => [],
      async () => {},
      async () => [],
      async () => [],
      { isHidden: () => hidden, setHidden: (hide) => void (hidden = hide) },
    );
    expect(workspace.agentFolderHidden()).toBe(false);
    workspace.setAgentFolderHidden(true);
    expect(workspace.agentFolderHidden()).toBe(true);
  });
});
