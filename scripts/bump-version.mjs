// `npm run version:bump <x.y.z>`: updates manifest.json, package.json and versions.json together.
import { readFile, writeFile } from 'node:fs/promises';
import { bumpedFiles } from './release.mjs';

const version = process.argv[2] ?? '';
const next = bumpedFiles(version, {
  manifest: await readFile('manifest.json', 'utf8'),
  pkg: await readFile('package.json', 'utf8'),
  versions: await readFile('versions.json', 'utf8'),
});
await writeFile('manifest.json', next.manifest);
await writeFile('package.json', next.pkg);
await writeFile('versions.json', next.versions);
console.log(`Version is now ${version}. Run: npm run package`);
