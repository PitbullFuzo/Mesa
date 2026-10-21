// `npm run package`: after a production build, writes release/mesa-<version>.zip with main.js, manifest.json, styles.css.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeZip } from './release.mjs';
import { createsScriptElements } from './noScriptElements.mjs';

const built = 'test-vault/.obsidian/plugins/mesa';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const main = await readFile(join(built, 'main.js'));
if (main.includes('sourceMappingURL=data:'))
  throw new Error('main.js is a development build. Run: npm run package');
if (createsScriptElements(main.toString('utf8')))
  throw new Error(
    'main.js still creates script elements (see scripts/noScriptElements.mjs).',
  );
const entries = [
  { name: 'main.js', data: main },
  { name: 'manifest.json', data: await readFile('manifest.json') },
  { name: 'styles.css', data: await readFile(join(built, 'styles.css')) },
];
await mkdir('release', { recursive: true });
const file = `release/mesa-${manifest.version}.zip`;
await writeFile(file, makeZip(entries));
console.log(`${file}: ${entries.map((e) => e.name).join(', ')}`);
