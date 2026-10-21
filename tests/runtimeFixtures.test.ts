import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { StreamJsonParser } from '../src/core/runtimes/claudeCode';
import type { RunEvent } from '../src/core/runtimes/types';

it.each(['normal', 'tool', 'tool-final', 'error'])(
  'parses recorded real %s fixture with fragmented input',
  (name) => {
    const bytes = readFileSync(
      new URL(`./fixtures/runtime-${name}.jsonl`, import.meta.url),
    );
    const events: RunEvent[] = [];
    const parser = new StreamJsonParser((event) => events.push(event));
    for (let offset = 0; offset < bytes.length; offset += 17)
      parser.push(bytes.subarray(offset, offset + 17));
    parser.end();
    const results = events.filter((event) => event.type === 'done');
    expect(events[0]).toEqual({
      type: 'session',
      sessionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(name === 'error');
    expect(typeof results[0]!.costUsd).toBe('number');
    expect(results[0]!.text.length).toBeGreaterThan(0);
    if (name === 'tool' || name === 'tool-final') {
      const tools = events.filter((event) => event.type === 'tool');
      expect(tools).toHaveLength(name === 'tool' ? 2 : 3);
      expect(tools.every((tool) => tool.name === 'Write')).toBe(true);
      expect(tools.at(-2)!.summary).toContain('.obsidian');
      expect(tools.at(-1)!.summary).toContain('Agents');
    }
    if (name === 'normal') {
      expect(
        events
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join(''),
      ).toBe(results[0]!.text);
    }
  },
);
