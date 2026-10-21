/* eslint obsidianmd/prefer-window-timers: off -- Pure core runs in Node (tests, the helper process) where there is no window. */
/**
 * Obi-I's own Microsoft 365 MCP helper (a small stdio server, bundled as m365_mcp.cjs). It reads mail, calendar and
 * OneDrive and can create a draft. Every other tool only writes a request into the run's outbox and waits: the plugin
 * shows the owner an Approve card and, only after Approve, does the action itself. This process never sends, deletes,
 * shares or overwrites anything.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ACTION_TOOLS, actionSchema } from './actions';
import { reads, txt } from './graph';

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const str = { type: 'string' };
const strings = { type: 'array', items: { type: 'string' } };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const WAIT = ' Needs the owner’s approval; it waits until they answer.';

export const TOOLS = [
  {
    name: 'mail_search',
    description:
      'Search or list mail (read only). query is optional; folder is inbox, sentitems or drafts.',
    inputSchema: obj({ query: str, folder: str, top: { type: 'number' } }),
  },
  {
    name: 'mail_read',
    description: 'Read one message by id (read only).',
    inputSchema: obj({ id: str }, ['id']),
  },
  {
    name: 'calendar_list',
    description:
      'List events between two ISO date-times (read only), e.g. 2026-10-21T00:00:00Z.',
    inputSchema: obj({ start: str, end: str }, ['start', 'end']),
  },
  {
    name: 'files_list',
    description: 'List OneDrive files in a folder path (read only).',
    inputSchema: obj({ path: str }),
  },
  {
    name: 'file_read',
    description: 'Read a OneDrive text file by id or path (read only).',
    inputSchema: obj({ id: str, path: str }),
  },
  {
    name: 'mail_draft',
    description:
      'Create a draft email in the owner’s Drafts. It is NOT sent. Use mail_send_draft to send it.',
    inputSchema: obj({ to: strings, subject: str, body: str }, [
      'to',
      'subject',
      'body',
    ]),
  },
  {
    name: 'mail_send',
    description: 'Send a new email.' + WAIT,
    inputSchema: obj({ to: strings, cc: strings, subject: str, body: str }, [
      'to',
      'subject',
      'body',
    ]),
  },
  {
    name: 'mail_send_draft',
    description: 'Send an existing draft by id.' + WAIT,
    inputSchema: obj({ id: str }, ['id']),
  },
  {
    name: 'mail_reply',
    description: 'Reply to a message.' + WAIT,
    inputSchema: obj({ id: str, body: str, all: { type: 'boolean' } }, [
      'id',
      'body',
    ]),
  },
  {
    name: 'mail_forward',
    description: 'Forward a message.' + WAIT,
    inputSchema: obj({ id: str, to: strings, comment: str }, ['id', 'to']),
  },
  {
    name: 'mail_delete',
    description: 'Delete a message.' + WAIT,
    inputSchema: obj({ id: str }, ['id']),
  },
  {
    name: 'event_create',
    description:
      'Create a calendar event (times are UTC ISO date-times; attendees are invited).' +
      WAIT,
    inputSchema: obj(
      {
        subject: str,
        start: str,
        end: str,
        attendees: strings,
        body: str,
      },
      ['subject', 'start', 'end'],
    ),
  },
  {
    name: 'event_respond',
    description:
      'Accept, decline or tentatively accept a calendar invitation (response: accept, decline or tentative).' +
      WAIT,
    inputSchema: obj({ id: str, response: str, comment: str }, [
      'id',
      'response',
    ]),
  },
  {
    name: 'file_share',
    description:
      'Create a sharing link for a OneDrive file (type: view or edit; scope: organization or anonymous).' +
      WAIT,
    inputSchema: obj({ id: str, type: str, scope: str }, [
      'id',
      'type',
      'scope',
    ]),
  },
  {
    name: 'file_write',
    description: 'Create or replace a OneDrive text file at a path.' + WAIT,
    inputSchema: obj({ path: str, content: str }, ['path', 'content']),
  },
];

const WAIT_MS = 20 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    if (i < 0 || !process.argv[i + 1]) throw Error('Missing option ' + name);
    return process.argv[i + 1]!;
  };
  const tokenFile = arg('--token-file'),
    outbox = arg('--outbox');
  const token = async () => {
    const parsed = record(JSON.parse(await readFile(tokenFile, 'utf8')));
    if (typeof parsed.accessToken !== 'string')
      throw new Error('No Microsoft access token for this run.');
    return parsed.accessToken;
  };
  const api = reads(token);

  /** Writes a request and waits for the plugin's answer. */
  async function ask(tool: string, args: unknown): Promise<string> {
    const parsed = actionSchema.safeParse({ ...record(args), tool });
    if (!parsed.success)
      throw new Error(
        'Invalid request: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; '),
      );
    const id = randomUUID();
    await writeFile(
      join(outbox, `${id}.intent.json`),
      JSON.stringify(parsed.data),
    );
    const result = join(outbox, `${id}.result.json`);
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      if (existsSync(result)) {
        const answer = record(JSON.parse(await readFile(result, 'utf8')));
        if (answer.rejected)
          return 'The owner rejected this action. It was not done.';
        if (typeof answer.error === 'string') throw new Error(answer.error);
        return txt(answer.ok) || 'Done.';
      }
      await sleep(400);
    }
    throw new Error('The owner did not answer in time. Nothing was done.');
  }

  async function call(name: string, a: Record<string, unknown>) {
    const text = (k: string) => (typeof a[k] === 'string' ? a[k] : undefined);
    switch (name) {
      case 'mail_search':
        return api.mailSearch({
          query: text('query'),
          folder: text('folder'),
          top: typeof a.top === 'number' ? a.top : undefined,
        });
      case 'mail_read':
        return api.mailRead(txt(text('id')));
      case 'calendar_list':
        return api.calendarList(txt(text('start')), txt(text('end')));
      case 'files_list':
        return api.filesList(text('path'));
      case 'file_read':
        return api.fileRead({ id: text('id'), path: text('path') });
      case 'mail_draft': {
        const to = Array.isArray(a.to) ? a.to.map(String) : [];
        return api.mailDraft({
          to,
          subject: txt(text('subject')),
          body: txt(text('body')),
        });
      }
      default:
        if (ACTION_TOOLS.includes(name as never)) return ask(name, a);
        throw new Error('Unknown tool ' + name);
    }
  }

  const output = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    void (async () => {
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(line));
      } catch {
        return;
      }
      const id = message.id;
      const params = record(message.params);
      if (id === undefined) return; // A notification.
      try {
        if (message.method === 'initialize')
          output({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params.protocolVersion ?? '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'agenthq-m365', version: '1' },
            },
          });
        else if (message.method === 'tools/list')
          output({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        else if (message.method === 'tools/call') {
          try {
            const text = await call(
              String(params.name),
              record(params.arguments),
            );
            output({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text }] },
            });
          } catch (error) {
            output({
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: error instanceof Error ? error.message : 'Failed.',
                  },
                ],
              },
            });
          }
        } else if (message.method === 'ping')
          output({ jsonrpc: '2.0', id, result: {} });
        else
          output({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'Method not found' },
          });
      } catch {
        /* Output closed. */
      }
    })();
  });
  input.on('close', () => process.exit(0));
}

if (process.argv.includes('--agenthq-m365'))
  void main().catch((error: unknown) => {
    process.stderr.write(
      'Obi-I Microsoft 365 helper could not start: ' +
        (error instanceof Error ? error.message : 'error') +
        '\n',
    );
    process.exit(1);
  });
