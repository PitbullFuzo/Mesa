import { describe, expect, it } from 'vitest';
import { GUIDE_BODY, GUIDE_SECTIONS, syncGuideNote } from '../src/core/guide';
import { MemoryStore } from '../src/core/memoryStore';
import { obiPrompt } from '../src/core/obi';

const OPTIONS = [
  'Hide all of Obi-I from search and the graph',
  'Hide only chats, everywhere',
  'Hide chats from the graph only',
];

describe('the graph and search section', () => {
  it('has the three options in the guide body', () => {
    expect(GUIDE_BODY).toContain('## Keeping your graph and search tidy');
    for (const option of OPTIONS) expect(GUIDE_BODY).toContain(option);
    expect(GUIDE_BODY).toContain('Obi-I/Chats');
    expect(GUIDE_BODY).toContain('-path:Obi-I/Chats');
  });

  it('is in Guide.md and in Obi’s prompt', async () => {
    const store = new MemoryStore('Obi-I');
    await syncGuideNote(store, 'Obi-I');
    const note = store.notes.get('Obi-I/Guide.md')!.body;
    for (const option of OPTIONS) expect(note).toContain(option);
    const prompt = obiPrompt([], []);
    for (const option of OPTIONS) expect(prompt).toContain(option);
  });

  it('stays out of the welcome tour pages', () => {
    expect(GUIDE_SECTIONS.map((section) => section.title)).not.toContain(
      'Keeping your graph and search tidy',
    );
  });
});
