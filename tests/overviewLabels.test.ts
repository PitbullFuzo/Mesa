import { describe, expect, it } from 'vitest';
import {
  analyseLinkGraph,
  buildLinkGraph,
  type GraphAnalysis,
} from '../src/core/graphMap';
import { DEFAULT_OVERVIEW, buildForceGraph } from '../src/core/overviewForce';
import {
  clusterName,
  LABEL_LIMIT,
  shortTitle,
} from '../src/core/overviewLabels';
import { loadSettings } from '../src/core/settings';
import { incomingLinkCounts, type VaultFile } from '../src/core/vaultMap';

describe('short note titles', () => {
  it('drops the folder, the extension and a leading date and time', () => {
    expect(shortTitle('Obi-I/Chats/2026-10-16 0731 Plan the launch.md')).toBe(
      'Plan the launch',
    );
    expect(shortTitle('Notes/2026-10-16 Weekly review.md')).toBe(
      'Weekly review',
    );
    expect(shortTitle('Notes/Plain.md')).toBe('Plain');
  });

  it('drops long ids and hashes', () => {
    expect(
      shortTitle(
        'Chats/2026-10-16 0731 Fix login 3f2a9c1b7d4e5f60a1b2c3d4e5f60718.md',
      ),
    ).toBe('Fix login');
    expect(
      shortTitle('Chats/Chat 123e4567-e89b-12d3-a456-426614174000.md'),
    ).toBe('Chat');
    expect(shortTitle('Chats/Session s12abc34def56gh.md')).toBe('Session');
  });

  it('cuts long titles with an ellipsis and falls back when nothing is left', () => {
    const long = shortTitle(`A/${'word '.repeat(20)}.md`);
    expect(long.length).toBeLessThanOrEqual(LABEL_LIMIT);
    expect(long.endsWith('…')).toBe(true);
    expect(shortTitle('Chats/2026-10-16 0731.md')).toBe('2026-10-16 0731');
    expect(shortTitle('Chats/3f2a9c1b7d4e5f60.md')).toBe('3f2a9c1b7d4e5f60');
  });
});

describe('cluster names', () => {
  it('uses the shared folder when most of the cluster is in it', () => {
    expect(
      clusterName('Obi-I/Chats/2026-10-16 0731 x.md', [
        'Obi-I/Chats/a.md',
        'Obi-I/Chats/b.md',
        'Obi-I/Chats/c.md',
        'Other/d.md',
      ]),
    ).toBe('Chats');
  });

  it('uses the hub short title when the folders are mixed or the notes are in the root', () => {
    expect(
      clusterName('Ideas/2026-10-16 Big plan.md', [
        'Ideas/a.md',
        'Notes/b.md',
        'Misc/c.md',
      ]),
    ).toBe('Big plan');
    expect(clusterName('Root note.md', ['Root note.md', 'Other.md'])).toBe(
      'Root note',
    );
  });
});

describe('the cluster list setting', () => {
  it('is on by default, remembered, and falls back when the saved value is bad', () => {
    expect(DEFAULT_OVERVIEW.showClusterList).toBe(true);
    const saved = {
      overview: { ...DEFAULT_OVERVIEW, showClusterList: false },
    };
    expect(loadSettings(saved).overview.showClusterList).toBe(false);
    expect(
      loadSettings({ overview: { showClusterList: 'x' } }).overview
        .showClusterList,
    ).toBe(true);
  });

  it('gives every cluster of the overview a short name', () => {
    const paths = ['Chats/2026-10-16 0731 a.md', 'Chats/b.md', 'Chats/c.md'];
    const links = {
      'Chats/2026-10-16 0731 a.md': { 'Chats/b.md': 1, 'Chats/c.md': 1 },
    };
    const incoming = incomingLinkCounts(links, 'Obi-I', '.obsidian');
    const files: VaultFile[] = paths.map((path, index) => ({
      path,
      mtime: index + 1,
      incomingLinks: incoming.get(path) ?? 0,
    }));
    const analysis: GraphAnalysis = analyseLinkGraph(
      buildLinkGraph(files, links, 'Obi-I', '.obsidian'),
    );
    expect(buildForceGraph(analysis).clusters.map((c) => c.name)).toEqual([
      'Chats',
    ]);
  });
});
