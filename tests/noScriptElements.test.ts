import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createsScriptElements,
  refuseScriptElements,
} from '../scripts/noScriptElements.mjs';

const reactDom = 'node_modules/react-dom/cjs/react-dom-client.production.js';

describe('script elements', () => {
  it('are not used anywhere in the source, and the source has no globalThis', () => {
    const texts: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name))
          texts.push(readFileSync(path, 'utf8'));
      }
    };
    walk('src');
    const source = texts.join(' ');
    for (const word of ['<script', 'preinit(', 'preload(', 'globalThis'])
      expect(source, word).not.toContain(word);
  });

  it("are refused in React DOM's client build, with a clear error", () => {
    const original = readFileSync(reactDom, 'utf8');
    expect(createsScriptElements(original)).toBe(true);
    const changed = refuseScriptElements(original);
    expect(createsScriptElements(changed)).toBe(false);
    expect(changed).toContain('Mesa does not create script elements.');
    // A text without the call is left as it was.
    expect(refuseScriptElements('const a = 1;')).toBe('const a = 1;');
  });

  it.runIf(existsSync('test-vault/.obsidian/plugins/obi-i/main.js'))(
    'are absent from the built main.js, and the plugin code has no globalThis',
    () => {
      const main = readFileSync(
        'test-vault/.obsidian/plugins/obi-i/main.js',
        'utf8',
      );
      if (main.includes('sourceMappingURL=data:')) return; // a development build: only production is checked
      expect(createsScriptElements(main)).toBe(false);
    },
  );
});
