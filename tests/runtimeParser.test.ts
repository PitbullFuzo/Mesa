import { expect, it } from 'vitest';
import { StreamJsonParser } from '../src/core/runtimes/claudeCode';
import type { RunEvent } from '../src/core/runtimes/types';

it.each([
  [
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Invalid API key. Please log in.'],
    },
    'auth',
    'Invalid API key. Please log in.',
  ],
  [
    {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Authentication required',
      },
    },
    'auth',
    'Authentication required',
  ],
  [
    {
      type: 'result',
      subtype: 'error_max_turns',
      errors: ['Turn limit reached'],
    },
    'other',
    'Turn limit reached',
  ],
])(
  'normalizes error envelopes %# without dropping details',
  (envelope, kind, text) => {
    const events: RunEvent[] = [];
    const parser = new StreamJsonParser((event) => events.push(event));
    parser.push(JSON.stringify(envelope));
    parser.end();
    expect(events).toEqual([
      { type: 'done', text, isError: true, errorKind: kind },
    ]);
  },
);

it('preserves error details when an error result contains an empty result field', () => {
  const events: RunEvent[] = [];
  const parser = new StreamJsonParser((event) => events.push(event));
  parser.push(
    JSON.stringify({
      type: 'result',
      is_error: true,
      result: '',
      errors: ['Authentication required'],
    }) + '\n',
  );
  expect(events).toEqual([
    {
      type: 'done',
      text: 'Authentication required',
      isError: true,
      errorKind: 'auth',
    },
  ]);
});

it('fails closed on malformed or incomplete output and emits only one terminal event', () => {
  const events: RunEvent[] = [];
  const parser = new StreamJsonParser((event) => events.push(event));
  expect(() => parser.push('not-json\n')).not.toThrow();
  parser.push('{"type":"result","result":"late"}\n');
  parser.end();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'done',
    isError: true,
    errorKind: 'other',
  });
  const incomplete: RunEvent[] = [];
  new StreamJsonParser((event) => incomplete.push(event)).end();
  expect(incomplete).toEqual([
    {
      type: 'done',
      text: 'Runtime exited without a result.',
      isError: true,
      errorKind: 'other',
    },
  ]);
});

it('assembles partial tool JSON into a useful summary and deduplicates the complete envelope', () => {
  const events: RunEvent[] = [];
  const parser = new StreamJsonParser((event) => events.push(event));
  const tool = { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} };
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: tool },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"/work/note.md"}' },
    },
    { type: 'content_block_stop', index: 0 },
  ])
    parser.push(JSON.stringify({ type: 'stream_event', event }) + '\n');
  parser.push(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ ...tool, input: { file_path: '/work/note.md' } }],
      },
    }) + '\n',
  );
  expect(events).toEqual([
    { type: 'tool', name: 'Read', summary: '/work/note.md' },
  ]);
});

it('parses chunked UTF-8 NDJSON, partial text, tool starts and final cost without duplicate text', () => {
  const events: RunEvent[] = [];
  const parser = new StreamJsonParser((event) => events.push(event));
  const lines = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'héllo' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} },
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'héllo' },
          {
            type: 'tool_use',
            id: 't',
            name: 'Read',
            input: { file_path: '/work/a.md' },
          },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'héllo',
      total_cost_usd: 0.02,
      is_error: false,
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\r\n');
  const bytes = Buffer.from(lines);
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  expect(events.filter((event) => event.type === 'text')).toEqual([
    { type: 'text', text: 'héllo' },
  ]);
  expect(events.filter((event) => event.type === 'tool')).toHaveLength(1);
  expect(events.at(-1)).toEqual({
    type: 'done',
    text: 'héllo',
    costUsd: 0.02,
    isError: false,
  });
});
