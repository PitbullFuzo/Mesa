import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import recorded from './fixtures/codex-permissions.json';
import { bumpedFiles, makeZip } from '../scripts/release.mjs';
import { embeddedHelpers, installHelpers } from '../src/core/helpers';
import { GUIDE_BODY, HELP_URL } from '../src/core/guide';
import { freeModels, parseOpenCodeModels } from '../src/core/models';
import { CodexParser } from '../src/core/runtimes/codex';
import { runtimeModelHint } from '../src/core/runtimes/ids';
import type { RunEvent, RuntimeAdapter } from '../src/core/runtimes/types';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';

describe('version bump', () => {
  const files = {
    manifest: JSON.stringify({
      id: 'agenthq',
      version: '0.1.0',
      minAppVersion: '1.7.2',
    }),
    pkg: JSON.stringify({ name: 'agenthq', version: '0.1.0' }),
    versions: JSON.stringify({ '0.1.0': '1.7.2' }),
  };
  it('updates manifest.json, package.json and versions.json together', () => {
    const next = bumpedFiles('0.2.0', files);
    expect(JSON.parse(next.manifest)).toMatchObject({
      version: '0.2.0',
      minAppVersion: '1.7.2',
    });
    expect(JSON.parse(next.pkg)).toMatchObject({
      version: '0.2.0',
      name: 'agenthq',
    });
    expect(JSON.parse(next.versions)).toEqual({
      '0.1.0': '1.7.2',
      '0.2.0': '1.7.2',
    });
  });
  it('refuses a bad or repeated version', () => {
    for (const bad of ['', '1.2', 'v1.2.3', '1.2.3-beta', '../x'])
      expect(() => bumpedFiles(bad, files)).toThrow(/not a version/);
    expect(() => bumpedFiles('0.1.0', files)).toThrow(/already/);
  });
});

/** Reads a zip back: name, method and inflated content of every entry, from the central directory. */
function readZip(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: { name: string; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const packedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = inflateRawSync(zip.subarray(start, start + packedSize));
    expect(data.length).toBe(size);
    out.push({ name, text: data.toString('utf8') });
    at += 46 + nameLength;
  }
  return out;
}

describe('release zip', () => {
  it('holds exactly the entries given, with their content, and is the same every time', () => {
    const entries = [
      { name: 'main.js', data: Buffer.from('console.log("é");'.repeat(50)) },
      { name: 'manifest.json', data: Buffer.from('{"version":"1.0.0"}') },
      { name: 'styles.css', data: Buffer.from('') },
    ];
    const zip = makeZip(entries);
    expect(readZip(zip)).toEqual(
      entries.map((e) => ({ name: e.name, text: e.data.toString('utf8') })),
    );
    expect(makeZip(entries).equals(zip)).toBe(true);
  });
});

describe('helper files written beside main.js', () => {
  const store = (initial: Record<string, string>) => {
    const files = { ...initial };
    const writes: string[] = [];
    return {
      files,
      writes,
      io: {
        exists: async (p: string) => p in files,
        read: async (p: string) => files[p]!,
        write: async (p: string, t: string) => {
          files[p] = t;
          writes.push(p);
        },
      },
    };
  };
  it('writes the missing or changed ones only, and nothing when they match', async () => {
    const s = store({ 'dir/a.cjs': 'same', 'dir/b.py': 'old' });
    const written = await installHelpers(
      { 'a.cjs': 'same', 'b.py': 'new', 'c.cjs': 'x' },
      'dir',
      s.io,
    );
    expect(written).toEqual(['b.py', 'c.cjs']);
    expect(s.files).toMatchObject({ 'dir/b.py': 'new', 'dir/c.cjs': 'x' });
    expect(
      await installHelpers(
        { 'a.cjs': 'same', 'b.py': 'new', 'c.cjs': 'x' },
        'dir',
        s.io,
      ),
    ).toEqual([]);
  });
  it('a development build embeds nothing, so it never overwrites its own files', () => {
    expect(embeddedHelpers()).toEqual({});
  });
});

describe('Help & feedback', () => {
  it('is a plain link to the site, also written in the guide', () => {
    expect(HELP_URL).toBe('https://trabalhoia.com');
    expect(GUIDE_BODY).toContain('How-tos and feedback: trabalhoia.com');
  });
});

describe('free OpenCode models', () => {
  it('keeps only the models marked free', () => {
    const list = parseOpenCodeModels(
      'opencode/nemotron-3.5-lightning-free\nanthropic/claude-sonnet\nopenrouter/some-model:free\n',
    );
    expect(freeModels(list).map((m) => m.value)).toEqual([
      'opencode/nemotron-3.5-lightning-free',
      'openrouter/some-model:free',
    ]);
    expect(freeModels([])).toEqual([]);
  });
});

describe('Codex tokens', () => {
  it('the finished run carries its token counts, and no dollar cost', () => {
    const events: RunEvent[] = [];
    const parser = new CodexParser((e) => events.push(e));
    parser.push(
      Buffer.from(
        recorded['permissions-final'].map((f) => JSON.stringify(f)).join('\n') +
          '\n',
      ),
    );
    parser.end();
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done' && !done.isError) {
      expect(done.tokens?.input).toBeGreaterThan(0);
      expect(done.tokens?.output).toBeGreaterThan(0);
      expect(done).not.toHaveProperty('costUsd');
    }
    const usage = events.find((e) => e.type === 'tool' && e.name === 'Usage');
    expect(usage && 'summary' in usage ? usage.summary : '').toContain(
      'not dollars',
    );
  });
  it('Setup says tokens are shown and do not count toward dollar caps', () => {
    expect(runtimeModelHint('codex')).toContain(
      'do not count toward dollar cost caps',
    );
  });
  it('a Codex reply is saved with its tokens and no price', async () => {
    const store = new MemoryStore('Mesa');
    const id = await store.createAgent('Codey');
    await store.patchAgent(id, { runtime: 'codex' });
    const adapter: RuntimeAdapter = {
      id: 'codex',
      displayName: 'Codex',
      detect: async () => ({ available: true }),
      start: (_request, onEvent) => {
        onEvent({
          type: 'done',
          text: 'hello',
          isError: false,
          tokens: { input: 1500, output: 500 },
        });
        return { stop: async () => {} };
      },
    };
    const chat = new ChatService({
      store,
      adapters: [adapter],
      settings: () => ({ maxParallelRuns: 1, allowedFolders: [] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      memoryDelayMs: 60_000,
    });
    await chat.initialize();
    await chat.send(id, 'hi');
    const reply = chat
      .getSnapshot()
      .agents[id]!.messages.find((m) => m.role === 'assistant')!;
    expect(reply.tokens).toBe(2000);
    expect(reply.costUsd).toBeUndefined();
    const saved = (await store.loadChats()).map((note) => note.body).join('');
    expect(saved).toContain('"tokens":2000');
  });
});
