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
import {
  LEGACY_PLUGIN_IDS,
  migrateAppData,
  PLUGIN_ID,
} from '../src/core/appData';
import { GUIDE_BODY, GUIDE_SECTIONS } from '../src/core/guide';
import { obiPrompt } from '../src/core/obi';
import { loadSettings } from '../src/core/settings';
import {
  decideTeamFolder,
  LEGACY_TEAM_FOLDERS,
  TEAM_FOLDER_CANDIDATES,
} from '../src/core/teamFolder';

const read = (path: string) => readFileSync(path, 'utf8');
const temp = () => mkdtempSync(join(tmpdir(), 'mesa-'));

describe('the store rules for the manifest', () => {
  const manifest = JSON.parse(read('manifest.json')) as Record<string, string>;

  it('is called Mesa with the id obi-i, and never mentions Obsidian or part of it', () => {
    expect(manifest.id).toBe('obi-i');
    expect(manifest.name).toBe('Mesa');
    expect(PLUGIN_ID).toBe('obi-i');
    for (const text of [manifest.name!, manifest.description!])
      expect(text).not.toMatch(/obsidian|\bob/i);
    expect(manifest.description!.length).toBeLessThanOrEqual(250);
    expect(manifest.description!.endsWith('.')).toBe(true);
    expect(manifest.fundingUrl).toBeUndefined();
  });

  it('builds, packages and releases from the same plugin folder, which is named by the id', () => {
    const folder = `plugins/${PLUGIN_ID}`;
    for (const file of [
      'esbuild.config.mjs',
      'scripts/package.mjs',
      '.github/workflows/release.yml',
    ])
      expect(read(file), file).toContain(folder);
    expect(read('.gitignore')).toContain(`test-vault/.obsidian/${folder}/*`);
    expect(read('README.md')).toContain(
      "The plugin's folder is called obi-i (its original ID); the plugin is Mesa.",
    );
    expect(
      (JSON.parse(read('manifest.json')) as { version: string }).version,
    ).toBe('1.0.3');
  });

  it('keeps the package name and the build folder in step', () => {
    expect((JSON.parse(read('package.json')) as { name: string }).name).toBe(
      'mesa',
    );
    expect(read('scripts/package.mjs')).toContain('release/mesa-');
    expect(read('esbuild.config.mjs')).toContain('plugins/obi-i');
  });
});

describe('no placeholder text in the READMEs', () => {
  const files = ['README.md', 'README.pt.md', 'INSTALL.md', 'INSTALL.pt.md'];
  it.each(files)('%s has no template-like patterns', (file) => {
    const text = read(file);
    expect(text).not.toMatch(/<[A-Za-z/][^>\n]*>/);
    expect(text).not.toMatch(/\[\.\.\.\]/);
    expect(text).not.toMatch(/\{[^}\n]*\}/);
    expect(text).not.toMatch(/\bTODO\b|\bTBD\b|\[description\]|<!--/);
    expect(text).not.toMatch(/%[A-Z_]+%/);
  });

  it.each(files)('%s names Mesa and links the Mesa repository', (file) => {
    const text = read(file);
    expect(text).not.toMatch(/Obi-I|AgentHQ|agenthq-obsidian/);
    if (file.startsWith('INSTALL'))
      expect(text).toContain('github.com/PitbullFuzo/Mesa');
  });
});

describe('the user-facing text', () => {
  it('says Mesa for the plugin and keeps Obi for the assistant', () => {
    const text = [
      GUIDE_BODY,
      ...GUIDE_SECTIONS.map((section) => section.title + section.body),
      obiPrompt([], [], {}),
    ].join('\n');
    expect(text).not.toMatch(/Obi-I|AgentHQ(?![A-Za-z])/);
    expect(text).toContain('Mesa');
    expect(text).toMatch(/Obi/);
  });

  it('gives new vaults the Mesa folder and leaves a saved earlier folder alone', () => {
    expect(loadSettings(null).agenthqFolder).toBe('Mesa');
    for (const folder of LEGACY_TEAM_FOLDERS)
      expect(loadSettings({ agenthqFolder: folder }).agenthqFolder).toBe(
        folder,
      );
  });
});

describe('the upgrade from the earlier names', () => {
  it('reads settings from the mesa plugin folder first, then the agenthq one', () => {
    expect(LEGACY_PLUGIN_IDS).toEqual(['mesa', 'agenthq']);
  });

  it('finds a team in Obi-I or AgentHQ, and offers it instead of creating one', async () => {
    expect(TEAM_FOLDER_CANDIDATES).toEqual(['Mesa', 'Obi-I', 'AgentHQ']);
    for (const holder of ['Obi-I', 'AgentHQ']) {
      const folders: Record<string, boolean> = { [holder]: true };
      const decision = await decideTeamFolder('Mesa', {
        exists: async (path) => path in folders,
        hasTeam: async (folder) => folders[folder] === true,
      });
      expect(decision).toEqual({
        action: 'offer',
        folder: 'Mesa',
        found: holder,
      });
    }
  });

  it('carries the Microsoft sign-in from Obi-I (newest first) to Mesa, and moves nothing it should not', async () => {
    const base = temp();
    for (const [name, text] of [
      ['Obi-I', 'NEWER'],
      ['AgentHQ', 'OLDER'],
    ] as const) {
      mkdirSync(join(base, name, 'connectors'), { recursive: true });
      writeFileSync(join(base, name, 'connectors', 'microsoft365.json'), text);
    }
    mkdirSync(join(base, 'Obi-I', 'browser-tools'), { recursive: true });
    writeFileSync(join(base, 'Obi-I', 'browser-tools', 'x'), 'B');
    expect(await migrateAppData(base)).toEqual(['connectors', 'browser-tools']);
    expect(read(join(base, 'Mesa', 'connectors', 'microsoft365.json'))).toBe(
      'NEWER',
    );
    // Copied, not moved: both old sign-ins are still there. The big browser folder was moved.
    expect(
      existsSync(join(base, 'Obi-I', 'connectors', 'microsoft365.json')),
    ).toBe(true);
    expect(
      existsSync(join(base, 'AgentHQ', 'connectors', 'microsoft365.json')),
    ).toBe(true);
    expect(existsSync(join(base, 'Mesa', 'browser-tools', 'x'))).toBe(true);
    // A second run changes nothing.
    expect(await migrateAppData(base)).toEqual([]);
  });

  it('falls back to the AgentHQ folder when there is no Obi-I one', async () => {
    const base = temp();
    mkdirSync(join(base, 'AgentHQ', 'connectors'), { recursive: true });
    writeFileSync(
      join(base, 'AgentHQ', 'connectors', 'microsoft365.json'),
      'OLD',
    );
    expect(await migrateAppData(base)).toEqual(['connectors']);
    expect(read(join(base, 'Mesa', 'connectors', 'microsoft365.json'))).toBe(
      'OLD',
    );
  });
});
