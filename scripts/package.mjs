// `npm run package`: after a production build, writes release/obi-i-<version>.zip with main.js, manifest.json, styles.css.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeZip } from './release.mjs';

const built = 'test-vault/.obsidian/plugins/obi-i';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const main = await readFile(join(built, 'main.js'));
if (main.includes('sourceMappingURL=data:'))
  throw new Error('main.js is a development build. Run: npm run package');
const entries = [
  { name: 'main.js', data: main },
  { name: 'manifest.json', data: await readFile('manifest.json') },
  { name: 'styles.css', data: await readFile(join(built, 'styles.css')) },
];
await mkdir('release', { recursive: true });
const file = `release/obi-i-${manifest.version}.zip`;
await writeFile(file, makeZip(entries));
console.log(`${file}: ${entries.map((e) => e.name).join(', ')}`);
