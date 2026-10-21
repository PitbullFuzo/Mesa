import { describe, expect, it } from 'vitest';
import { loadSettings } from '../src/core/settings';
import { DEFAULT_NOTE_TYPES } from '../src/core/noteTypes';
import { DEFAULT_OVERVIEW } from '../src/core/overviewForce';

describe('settings', () => {
  it('provides all v1 defaults for a fresh install', () => {
    expect(loadSettings(null)).toEqual({
      agenthqFolder: 'Mesa',
      allowedFolders: [],
      maxParallelRuns: 3,
      maxDelegationDepth: 3,
      maxRunsPerRequest: 25,
      defaultVerifierAttempts: 3,
      runtimePathOverride: '',
      developerMode: false,
      browserEngine: 'playwright',
      enterToSend: true,
      agentPanelPlacement: 'side',
      obiSeeded: false,
      tourDone: false,
      disclaimerAccepted: false,
      selfTests: {},
      memoryModel: 'auto',
      m365ClientId: '',
      m365Authority: 'consumers',
      m365Account: '',
      noteTypes: DEFAULT_NOTE_TYPES,
      graphAi: false,
      graphAiModel: '',
      overview: DEFAULT_OVERVIEW,
    });
  });

  it('restores every saved setting after a JSON round trip', () => {
    const saved = {
      agenthqFolder: 'My team',
      allowedFolders: ['Notes', 'C:/Projects'],
      maxParallelRuns: 2,
      maxDelegationDepth: 4,
      maxRunsPerRequest: 12,
      defaultVerifierAttempts: 5,
      runtimePathOverride: 'C:/Tools/runtime.exe',
      developerMode: true,
      browserEngine: 'hermes',
      enterToSend: false,
      agentPanelPlacement: 'main',
      obiSeeded: true,
      tourDone: true,
      disclaimerAccepted: true,
      selfTests: {
        'codex 0.163.0': {
          result: 'pass',
          detail: 'all sandbox probes behaved as required',
          checkedAt: '2026-10-20T10:00:00.000Z',
        },
      },
      memoryModel: 'auto',
      m365ClientId: '11111111-1111-4111-8111-111111111111',
      m365Authority: 'common',
      m365Account: 'Me (me@example.com)',
      noteTypes: [
        {
          id: 'meeting',
          label: 'Meeting notes',
          folder: 'Work/Meetings',
          enabled: false,
        },
      ],
      graphAi: true,
      graphAiModel: 'opencode/mimo-v2.6-flash-free',
      overview: { ...DEFAULT_OVERVIEW, nodeSize: 2, showOrphans: false },
    };
    expect(loadSettings(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it('keeps saved values when new default fields are added', () => {
    expect(loadSettings({ maxParallelRuns: 7 })).toEqual({
      ...loadSettings(null),
      maxParallelRuns: 7,
    });
  });

  it('recovers defaults from invalid settings without throwing', () => {
    expect(
      loadSettings({
        agenthqFolder: '',
        allowedFolders: 'Notes',
        maxParallelRuns: 0,
        maxDelegationDepth: -1,
        maxRunsPerRequest: 1.5,
        defaultVerifierAttempts: '3',
        runtimePathOverride: null,
        browserEngine: 'unknown',
      }),
    ).toEqual(loadSettings(null));
    expect(loadSettings('invalid')).toEqual(loadSettings(null));
  });

  it('returns defaults for array-valued saved data', () => {
    expect(loadSettings([])).toEqual(loadSettings(null));
    expect(loadSettings(['invalid'])).toEqual(loadSettings(null));
  });

  it('returns defaults for a top-level string', () => {
    expect(loadSettings('text')).toEqual(loadSettings(null));
  });

  it('returns defaults for non-plain objects rather than using their properties', () => {
    const data = Object.assign(new Date(0), { maxParallelRuns: 7 });
    expect(loadSettings(data)).toEqual(loadSettings(null));
  });

  it('recovers defaults when reading saved data throws', () => {
    const data = {
      get maxParallelRuns(): number {
        throw new Error('Unreadable saved setting');
      },
    };
    expect(loadSettings(data)).toEqual(loadSettings(null));
  });

  it('does not share mutable folder lists across installations', () => {
    const first = loadSettings(null);
    first.allowedFolders.push('Notes');
    expect(loadSettings(null).allowedFolders).toEqual([]);
  });
});
