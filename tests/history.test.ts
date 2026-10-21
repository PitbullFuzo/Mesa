import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/core/model';
import type { NoteDocument } from '../src/core/notes';
import { historyRows } from '../src/core/history';

function agent(id: string, group: string | null): Agent {
  return { id, name: id.toUpperCase(), group } as Agent;
}

function note(title: string, started: string | undefined): NoteDocument {
  return {
    path: `Mesa/Chats/${title}.md`,
    name: title,
    frontmatter: started === undefined ? {} : { started },
    body: '',
  };
}

const chats = [
  {
    agent: agent('coder', 'core'),
    status: 'idle',
    history: [
      note('Zebra planning', '2026-10-01T09:00:00.000Z'),
      note('Apple review', '2026-10-05T09:00:00.000Z'),
    ],
  },
  {
    agent: agent('designer', 'core'),
    status: 'working',
    history: [note('Middle sketch', '2026-10-03T09:00:00.000Z')],
  },
  {
    agent: agent('scribe', null),
    status: 'offline',
    history: [note('Undated notes', undefined)],
  },
];

describe('History rows', () => {
  it('sorts newest first by start date, not alphabetically by title', () => {
    const titles = historyRows(chats, 'all', 'coder').map(
      (row) => row.note.name,
    );
    expect(titles).toEqual([
      'Apple review',
      'Middle sketch',
      'Zebra planning',
      'Undated notes',
    ]);
  });

  it('lists only the selected agent in agent scope', () => {
    const rows = historyRows(chats, 'agent', 'designer');
    expect(rows.map((row) => row.agent.id)).toEqual(['designer']);
    expect(rows[0]!.status).toBe('working');
  });

  it('lists one group in group scope', () => {
    const rows = historyRows(chats, 'group:core', 'coder');
    expect(rows.map((row) => row.agent.id).sort()).toEqual([
      'coder',
      'coder',
      'designer',
    ]);
  });

  it('lists every agent in All scope, including ungrouped ones', () => {
    expect(historyRows(chats, 'all', 'coder')).toHaveLength(4);
  });
});
