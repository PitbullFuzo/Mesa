import { readdir, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImportedSkill } from '../vaultPowers';

export const IMPORT_SKILLS_LABEL = 'Import my Claude skills';
export async function readInstalledSkills(
  source = join(homedir(), '.claude', 'skills'),
) {
  const entries = await readdir(source, { withFileTypes: true }).catch(() => {
    throw new Error(
      `No installed skills folder found at ${source}. Nothing was imported.`,
    );
  });
  const skills: ImportedSkill[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) {
      skipped.push({ name: entry.name, reason: 'Symbolic link skipped' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const path = join(source, entry.name, 'SKILL.md');
      if (!(await lstat(path)).isFile()) throw new Error('Not a regular file');
      skills.push({ name: entry.name, body: await readFile(path, 'utf8') });
    } catch {
      skipped.push({
        name: entry.name,
        reason: 'No readable regular SKILL.md',
      });
    }
  }
  return { skills, skipped };
}
