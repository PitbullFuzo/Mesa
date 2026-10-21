import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readInstalledSkills } from '../src/core/runtimes/skills';

describe('installed skill import source', () => {
  it('reads only immediate SKILL.md files and reports missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenthq-skills-'));
    await mkdir(join(root, 'writer'));
    await writeFile(join(root, 'writer', 'SKILL.md'), '# Writer\nBe clear.');
    await mkdir(join(root, 'empty'));
    await writeFile(join(root, 'not-a-skill.txt'), 'ignore');
    const result = await readInstalledSkills(root);
    expect(result.skills).toEqual([
      { name: 'writer', body: '# Writer\nBe clear.' },
    ]);
    expect(result.skipped).toEqual([
      { name: 'empty', reason: 'No readable regular SKILL.md' },
    ]);
    await expect(readInstalledSkills(join(root, 'absent'))).rejects.toThrow(
      'No installed skills folder',
    );
  });
});
