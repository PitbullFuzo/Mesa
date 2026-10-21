import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateAppData } from '../src/core/appData';
import { GUIDE_BODY, GUIDE_SECTIONS } from '../src/core/guide';
import { DEFAULT_M365_CLIENT_ID } from '../src/core/m365/auth';
import { OBI_LABEL, OBI_NAME, obiPrompt } from '../src/core/obi';
import { loadSettings } from '../src/core/settings';

const temp = () => mkdtempSync(join(tmpdir(), 'obii-rename-'));

describe('the new name', () => {
  it('names the plugin Obi-I with the id obi-i', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as {
      id: string;
      name: string;
    };
    expect(manifest).toMatchObject({ id: 'obi-i', name: 'Obi-I' });
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('obi-i');
  });

  it('gives a new vault the Obi-I folder, and leaves a saved AgentHQ folder alone', () => {
    expect(loadSettings(null).agenthqFolder).toBe('Obi-I');
    expect(loadSettings({ agenthqFolder: 'AgentHQ' }).agenthqFolder).toBe(
      'AgentHQ',
    );
  });

  it('calls the assistant Obi and keeps its id so chats still link', () => {
    expect(OBI_LABEL).toBe('Obi');
    expect(OBI_NAME).toBe('Obi');
  });

  it('leaves no AgentHQ in what the guide, the tour and Obi say', () => {
    const text = [
      GUIDE_BODY,
      ...GUIDE_SECTIONS.map((section) => section.title + section.body),
      obiPrompt([], [], {}),
    ].join('\n');
    expect(text).not.toMatch(/AgentHQ(?![A-Za-z])/);
    expect(text).not.toContain('Obi.I');
  });

  it('uses the shared Microsoft app when the field is empty', () => {
    expect(DEFAULT_M365_CLIENT_ID).toBe('b4b08f10-f311-4536-a773-f9fdca1810f9');
    expect(loadSettings(null).m365ClientId).toBe('');
  });
});

describe('carrying the earlier app-data folder over', () => {
  it('copies the Microsoft sign-in, moves the browser tools, and leaves the old sign-in in place', async () => {
    const base = temp();
    mkdirSync(join(base, 'AgentHQ', 'connectors'), { recursive: true });
    writeFileSync(
      join(base, 'AgentHQ', 'connectors', 'microsoft365.json'),
      'T',
    );
    mkdirSync(join(base, 'AgentHQ', 'browser-tools'), { recursive: true });
    writeFileSync(join(base, 'AgentHQ', 'browser-tools', 'x'), 'B');
    expect(await migrateAppData(base)).toEqual(['connectors', 'browser-tools']);
    expect(
      readFileSync(
        join(base, 'Obi-I', 'connectors', 'microsoft365.json'),
        'utf8',
      ),
    ).toBe('T');
    expect(
      existsSync(join(base, 'AgentHQ', 'connectors', 'microsoft365.json')),
    ).toBe(true);
    expect(existsSync(join(base, 'Obi-I', 'browser-tools', 'x'))).toBe(true);
  });

  it('never overwrites what the new folder already has, and does nothing without an old folder', async () => {
    const base = temp();
    expect(await migrateAppData(base)).toEqual([]);
    mkdirSync(join(base, 'AgentHQ', 'connectors'), { recursive: true });
    writeFileSync(
      join(base, 'AgentHQ', 'connectors', 'microsoft365.json'),
      'OLD',
    );
    mkdirSync(join(base, 'Obi-I', 'connectors'), { recursive: true });
    writeFileSync(
      join(base, 'Obi-I', 'connectors', 'microsoft365.json'),
      'NEW',
    );
    expect(await migrateAppData(base)).toEqual([]);
    expect(
      readFileSync(
        join(base, 'Obi-I', 'connectors', 'microsoft365.json'),
        'utf8',
      ),
    ).toBe('NEW');
  });
});
