import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { withAttachments } from '../src/core/composer';
import {
  cleanReplacement,
  inlineEditPrompt,
  paragraphRange,
  wordDiff,
} from '../src/core/inlineEdit';
import { MemoryStore } from '../src/core/memoryStore';
import {
  chatExcerpt,
  folderListing,
  fuzzyScore,
  mentionQuery,
  rankMentions,
  withoutMention,
  FOLDER_LIST_CAP,
  type MentionCandidate,
} from '../src/core/mentions';
import { ensureObi, OBI_ID } from '../src/core/obi';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '../src/core/runtimes/types';
import { parseSlash, quotedSideNote } from '../src/core/slash';

describe('the word-level diff', () => {
  it('marks only the words that changed, and rebuilds both texts', () => {
    const before = 'The quick brown fox jumps';
    const after = 'The slow brown fox leaps high';
    const parts = wordDiff(before, after);
    expect(
      parts
        .filter((p) => p.type !== 'add')
        .map((p) => p.text)
        .join(''),
    ).toBe(before);
    expect(
      parts
        .filter((p) => p.type !== 'del')
        .map((p) => p.text)
        .join(''),
    ).toBe(after);
    expect(parts.find((p) => p.type === 'del')?.text).toContain('quick');
    expect(parts.find((p) => p.type === 'add')?.text).toContain('slow');
    expect(
      parts.some((p) => p.type === 'same' && p.text.includes('brown fox')),
    ).toBe(true);
  });

  it('is one unchanged part when nothing changed, and copes with very long texts', () => {
    expect(wordDiff('same words', 'same words')).toEqual([
      { type: 'same', text: 'same words' },
    ]);
    const long = 'word '.repeat(2000);
    expect(wordDiff(long, long + 'more').map((p) => p.type)).toEqual([
      'del',
      'add',
    ]);
  });
});

describe('the inline edit text', () => {
  it('asks for the replacement only, with context marked as context', () => {
    const prompt = inlineEditPrompt({
      instruction: 'shorter',
      selection: 'A long sentence.',
      before: 'Before.',
      after: 'After.',
    });
    expect(prompt).toContain('ONLY the replacement text');
    expect(prompt).toContain('Instruction: shorter');
    expect(prompt).toContain('<<<\nA long sentence.\n>>>');
    expect(prompt).toContain('context only');
  });

  it("removes a wrapping fence the agent added, and keeps the selection's surrounding space", () => {
    expect(cleanReplacement('```\nShort.\n```', 'A long sentence.')).toBe(
      'Short.',
    );
    expect(cleanReplacement('Short.\n', '  A long sentence.\n')).toBe(
      '  Short.\n',
    );
    expect(cleanReplacement('```js\ncode\n```', '```js\nold\n```')).toBe(
      '```js\ncode\n```',
    );
  });

  it('finds the paragraph around a line, and nothing on a blank line', () => {
    const lines = ['# Title', '', 'one', 'two', '', 'three'];
    expect(paragraphRange(lines, 3)).toEqual({ from: 2, to: 3 });
    expect(paragraphRange(lines, 1)).toBeNull();
    expect(paragraphRange(lines, 5)).toEqual({ from: 5, to: 5 });
  });
});

describe('@mentions', () => {
  it('finds the @word at the caret, but not an @ inside a word', () => {
    expect(mentionQuery('hello @pla', 10)).toEqual({ start: 6, query: 'pla' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail me@example.com', 19)).toBeNull();
    expect(mentionQuery('hello @plan and more', 20)).toBeNull();
    expect(withoutMention('hello @pla and', 6, 10)).toBe('hello and');
  });

  it('ranks fuzzy matches, best first, and drops what does not match', () => {
    const items: MentionCandidate[] = [
      { kind: 'note', label: 'Project plan', path: 'Work/Project plan.md' },
      { kind: 'note', label: 'Shopping', path: 'Home/Shopping.md' },
      { kind: 'folder', label: 'Plans', path: 'Plans' },
      {
        kind: 'chat',
        label: 'CEO: planning the week',
        path: 'Mesa/Chats/a.md',
      },
    ];
    const names = rankMentions('plan', items).map((item) => item.label);
    expect(names).not.toContain('Shopping');
    expect(names[0]).toBe('Plans');
    expect(rankMentions('ppl', items).map((i) => i.label)).toContain(
      'Project plan',
    );
    expect(fuzzyScore('zzz', 'Project plan')).toBe(0);
    expect(rankMentions('', items, 2)).toHaveLength(2);
  });

  it('attaches a folder as a capped list of paths and a chat as its title and last messages', () => {
    const paths = Array.from(
      { length: FOLDER_LIST_CAP + 5 },
      (_, i) => `Work/n${i}.md`,
    );
    const folder = folderListing('Work', paths);
    expect(folder.truncated).toBe(true);
    expect(folder.content.split('\n')).toHaveLength(FOLDER_LIST_CAP + 1);
    const chat = chatExcerpt(
      'Launch',
      Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `m${i}`,
      })),
    );
    expect(chat.content).toContain('Chat "Launch"');
    expect(chat.content).toContain('m9');
    expect(chat.content).not.toContain('m3');
  });

  it('puts every attachment in front of the message, with its own wording', () => {
    const text = withAttachments('Question', [
      { path: 'Notes/a.md', kind: 'note', content: 'A', truncated: false },
      { path: 'Work', kind: 'folder', content: 'List', truncated: true },
      { path: 'CEO: Launch', kind: 'chat', content: 'Chat', truncated: false },
    ]);
    expect(text.indexOf('this note')).toBeLessThan(
      text.indexOf('this folder listing'),
    );
    expect(text.indexOf('this folder listing')).toBeLessThan(
      text.indexOf('this chat'),
    );
    expect(text.endsWith('---\nQuestion')).toBe(true);
    expect(withAttachments('Plain', [])).toBe('Plain');
  });
});

describe('/side', () => {
  it('is also written /btw, and its answer can be quoted into the main chat', () => {
    expect(parseSlash('/side what is x?')).toEqual({
      name: 'side',
      rest: 'what is x?',
    });
    expect(parseSlash('/btw what is x?')).toEqual({
      name: 'side',
      rest: 'what is x?',
    });
    expect(quotedSideNote('what is x?', 'Line one\nLine two')).toBe(
      'Side chat, what is x?\n> Line one\n> Line two\n\n',
    );
  });
});

describe('the one-off and side runs', () => {
  class Recording implements RuntimeAdapter {
    id = 'fake' as const;
    displayName = 'Test runtime';
    requests: RunRequest[] = [];
    async detect() {
      return { available: true };
    }
    start(request: RunRequest, callback: (event: RunEvent) => void) {
      this.requests.push(request);
      queueMicrotask(() => {
        callback({ type: 'session', sessionId: request.sessionId });
        callback({
          type: 'done',
          text: 'answer',
          costUsd: 0.01,
          isError: false,
        });
      });
      return { stop: async () => {} };
    }
  }

  async function setup() {
    const store = new MemoryStore();
    await ensureObi(store, store.root);
    await store.patchAgent(OBI_ID, { runtime: 'fake' });
    const runtime = new Recording();
    const service = new ChatService({
      store,
      adapters: [runtime],
      settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Mesa/Work'] }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      agentLink: async () => '[[Obi]]',
    });
    await service.initialize();
    return { service, runtime };
  }

  it('runs read-only in a fresh session with no vault access, and saves nothing', async () => {
    const { service, runtime } = await setup();
    const result = await service.askOnce(
      OBI_ID,
      'Edit this',
      new AbortController().signal,
    );
    expect(result).toEqual({ text: 'answer', costUsd: 0.01, isError: false });
    const request = runtime.requests[0]!;
    expect(request.permission).toBe('read-only');
    expect(request.resume).toBe(false);
    expect(request.extraDirs).toEqual([]);
    expect(request.readDirs).toEqual([]);
    expect(service.getSnapshot().agents[OBI_ID]!.messages).toEqual([]);
  });

  it('answers a side question without touching the main conversation or its session', async () => {
    const { service, runtime } = await setup();
    await service.send(OBI_ID, 'main question');
    const before = service.getSnapshot().agents[OBI_ID]!;
    const mainSession = before.session?.sessionId;
    const mainMessages = before.messages.length;
    const result = await service.sideChat(
      OBI_ID,
      'quick aside',
      new AbortController().signal,
    );
    expect(result.text).toBe('answer');
    const side = runtime.requests.at(-1)!;
    expect(side.prompt).toContain('main question');
    expect(side.prompt).toContain('Side question: quick aside');
    expect(side.sessionId).not.toBe(mainSession);
    expect(side.resume).toBe(false);
    const after = service.getSnapshot().agents[OBI_ID]!;
    expect(after.session?.sessionId).toBe(mainSession);
    expect(after.messages).toHaveLength(mainMessages);
  });
});
