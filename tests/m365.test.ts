import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_TOOLS,
  actionSchema,
  describeAction,
  executeAction,
  summarizeTarget,
  type Action,
} from '../src/core/m365/actions';
import {
  accessToken,
  disconnect,
  finishDeviceCode,
  isConnected,
  startDeviceCode,
} from '../src/core/m365/auth';
import { reads } from '../src/core/m365/graph';
import {
  m365ServerCommand,
  m365UnavailableReason,
  watchOutbox,
} from '../src/core/m365/launch';
import { TOOLS } from '../src/core/m365/mcpServer';

interface Call {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A pretend Microsoft: records every call and answers from a table (default: 200 with {}). */
function fakeFetch(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const key = Object.keys(answers).find((k) => call.url.includes(k));
    const answer = key ? answers[key] : {};
    if (answer instanceof Response) return answer;
    return new Response(
      typeof answer === 'string' ? answer : JSON.stringify(answer),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { f, calls };
}

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthq-m365-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const send: Action = {
  tool: 'mail_send',
  to: ['boss@example.com'],
  cc: ['a@example.com'],
  subject: 'Quarterly numbers',
  body: 'Hello,\nthe numbers are attached.',
};

describe('requests an agent can make', () => {
  it('accepts exactly the nine outward, destructive, sharing and file-writing tools', () => {
    expect([...ACTION_TOOLS].sort()).toEqual(
      [
        'event_create',
        'event_respond',
        'file_share',
        'file_write',
        'mail_delete',
        'mail_forward',
        'mail_reply',
        'mail_send',
        'mail_send_draft',
      ].sort(),
    );
  });
  it('refuses bad addresses, path traversal and unknown tools', () => {
    for (const bad of [
      { ...send, to: ['not-an-address'] },
      { ...send, to: [] },
      { tool: 'file_write', path: '../x.txt', content: 'a' },
      { tool: 'file_write', path: 'a/./b.txt', content: 'a' },
      { tool: 'file_share', id: 'x', type: 'view', scope: 'users' },
      { tool: 'mail_everything' },
    ])
      expect(actionSchema.safeParse(bad).success).toBe(false);
    expect(actionSchema.safeParse(send).success).toBe(true);
  });
  it('shows the full content on the card, from the request itself', () => {
    const card = describeAction(send);
    expect(card.title).toBe('Send an email');
    expect(card.text).toContain('To: boss@example.com');
    expect(card.text).toContain('Cc: a@example.com');
    expect(card.text).toContain('Subject: Quarterly numbers');
    expect(card.text).toContain('the numbers are attached.');
    const write = describeAction({
      tool: 'file_write',
      path: 'Docs/plan.txt',
      content: 'new text',
    });
    expect(write.title).toContain('replaces it if it exists');
    expect(write.text).toContain('Path: Docs/plan.txt');
    expect(write.text).toContain('new text');
    expect(
      describeAction({
        tool: 'file_share',
        id: 'f1',
        type: 'edit',
        scope: 'anonymous',
      }).text,
    ).toContain('anyone who has the link');
  });
  it('names the message, event or file a card points at when Microsoft answers', async () => {
    const { f } = fakeFetch({
      '/me/messages/m1': {
        subject: 'Invoice',
        from: { emailAddress: { name: 'Pat', address: 'pat@example.com' } },
      },
    });
    const extra = await summarizeTarget(
      { tool: 'mail_delete', id: 'm1' },
      't',
      f,
    );
    expect(extra).toContain('"Invoice" from Pat <pat@example.com>');
    expect(
      describeAction({ tool: 'mail_delete', id: 'm1' }, extra).text,
    ).toContain('Invoice');
    const failing = (async () =>
      new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(
      await summarizeTarget({ tool: 'mail_delete', id: 'm1' }, 't', failing),
    ).toBe('');
  });
});

describe('what an approved action does at Microsoft', () => {
  const run = async (action: Action) => {
    const { f, calls } = fakeFetch({
      createLink: { link: { webUrl: 'https://1drv.ms/x' } },
    });
    const result = await executeAction(action, 'TOKEN', f);
    return { result, calls };
  };
  it.each<[Action, string, string]>([
    [send, 'POST', '/me/sendMail'],
    [{ tool: 'mail_send_draft', id: 'd1' }, 'POST', '/me/messages/d1/send'],
    [
      { tool: 'mail_reply', id: 'm1', body: 'ok' },
      'POST',
      '/me/messages/m1/reply',
    ],
    [
      { tool: 'mail_reply', id: 'm1', body: 'ok', all: true },
      'POST',
      '/me/messages/m1/replyAll',
    ],
    [
      { tool: 'mail_forward', id: 'm1', to: ['b@example.com'] },
      'POST',
      '/me/messages/m1/forward',
    ],
    [{ tool: 'mail_delete', id: 'm1' }, 'DELETE', '/me/messages/m1'],
    [
      {
        tool: 'event_create',
        subject: 's',
        start: '2026-10-21T10:00:00',
        end: '2026-10-21T11:00:00',
      },
      'POST',
      '/me/events',
    ],
    [
      { tool: 'event_respond', id: 'e1', response: 'accept' },
      'POST',
      '/me/events/e1/accept',
    ],
    [
      { tool: 'event_respond', id: 'e1', response: 'decline' },
      'POST',
      '/me/events/e1/decline',
    ],
    [
      { tool: 'event_respond', id: 'e1', response: 'tentative' },
      'POST',
      '/me/events/e1/tentativelyAccept',
    ],
    [
      {
        tool: 'file_share',
        id: 'f1',
        type: 'view',
        scope: 'organization',
      },
      'POST',
      '/me/drive/items/f1/createLink',
    ],
    [
      { tool: 'file_write', path: 'A b/c.txt', content: 'x' },
      'PUT',
      '/me/drive/root:/A%20b/c.txt:/content',
    ],
  ])(
    '%j → %s %s, once, with the plugin’s token',
    async (action, method, path) => {
      const { calls } = await run(action);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(method);
      expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0' + path);
      expect(calls[0]!.headers.Authorization).toBe('Bearer TOKEN');
    },
  );
  it('sends the whole message and says what happened', async () => {
    const { calls, result } = await run(send);
    const body = JSON.parse(calls[0]!.body) as {
      message: {
        subject: string;
        toRecipients: unknown[];
        body: { content: string };
      };
    };
    expect(body.message.subject).toBe('Quarterly numbers');
    expect(body.message.toRecipients).toHaveLength(1);
    expect(result).toBe('The email was sent.');
    expect(
      (
        await run({
          tool: 'file_share',
          id: 'f1',
          type: 'view',
          scope: 'anonymous',
        })
      ).result,
    ).toContain('https://1drv.ms/x');
  });
});

describe('the helper’s read tools', () => {
  it('only read, and a failed call does not echo the token', async () => {
    const { f, calls } = fakeFetch({
      '/me/messages?': {
        value: [
          {
            id: 'm1',
            subject: 'Hi',
            from: { emailAddress: { name: 'Pat', address: 'p@example.com' } },
            receivedDateTime: '2026-10-20T10:00:00Z',
            bodyPreview: 'hello there',
          },
        ],
      },
    });
    const api = reads(async () => 'SECRET-TOKEN', f);
    const text = await api.mailSearch({ query: 'invoice', top: 500 });
    expect(text).toContain('id: m1');
    expect(text).toContain('Pat <p@example.com>');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('%24top=25');
    expect(calls[0]!.url).toContain('%24search=');
    const failing = reads(
      async () => 'SECRET-TOKEN',
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'Denied', message: 'no' } }),
          {
            status: 403,
          },
        ),
    );
    await expect(failing.mailRead('m1')).rejects.toThrow(
      /Permission not granted.*403 Denied/,
    );
    await expect(failing.mailRead('m1')).rejects.not.toThrow(/SECRET/);
  });
  it('creates a draft without sending anything', async () => {
    const { f, calls } = fakeFetch({ '/me/messages': { id: 'd9' } });
    const text = await reads(async () => 't', f).mailDraft({
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
    });
    expect(text).toContain('Nothing was sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/messages');
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false);
  });
  it('lists exactly the read tools, the draft tool and the nine request tools', () => {
    const names = TOOLS.map((t) => t.name);
    for (const tool of ACTION_TOOLS) expect(names).toContain(tool);
    expect(
      names.filter((n) => !(ACTION_TOOLS as string[]).includes(n)).sort(),
    ).toEqual([
      'calendar_list',
      'file_read',
      'files_list',
      'mail_draft',
      'mail_read',
      'mail_search',
    ]);
    expect(names).toHaveLength(15);
  });
});

describe('the outbox: nothing is done without an approved card', () => {
  const setup = async (answer: boolean | 'never') => {
    const outbox = temp();
    const { f, calls } = fakeFetch();
    const asked: { title: string; text: string }[] = [];
    const stop = watchOutbox(
      outbox,
      (card) => {
        asked.push(card);
        return answer === 'never'
          ? new Promise<boolean>(() => {})
          : Promise.resolve(answer);
      },
      { token: async () => 'TOKEN', f, everyMs: 20 },
    );
    return { outbox, calls, asked, stop };
  };
  // Requests are renamed into place so the watcher never reads half a file; results are awaited, not raced.
  const request = (outbox: string, id: string, action: unknown) => {
    const temporary = join(outbox, `${id}.tmp`);
    writeFileSync(temporary, JSON.stringify(action));
    renameSync(temporary, join(outbox, `${id}.intent.json`));
  };
  const result = async (outbox: string, id: string) => {
    const file = join(outbox, `${id}.result.json`);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true), {
      timeout: 5000,
    });
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  };

  it('Approve shows the card first, then does the action once', async () => {
    const s = await setup(true);
    request(s.outbox, 'a', send);
    expect(await result(s.outbox, 'a')).toEqual({ ok: 'The email was sent.' });
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.text).toContain('boss@example.com');
    expect(s.calls.filter((c) => c.url.endsWith('/sendMail'))).toHaveLength(1);
    s.stop();
  });
  it('Reject does nothing at Microsoft', async () => {
    const s = await setup(false);
    request(s.outbox, 'a', { tool: 'mail_delete', id: 'm1' });
    expect(await result(s.outbox, 'a')).toEqual({ rejected: true });
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    s.stop();
  });
  it('an unanswered card does nothing', async () => {
    const s = await setup('never');
    request(s.outbox, 'a', send);
    await vi.waitFor(() => expect(s.asked).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(join(s.outbox, 'a.result.json'))).toBe(false);
    expect(s.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    s.stop();
  });
  it('an invalid or unknown request is refused without a card or a call', async () => {
    const s = await setup(true);
    request(s.outbox, 'a', {
      tool: 'mail_send',
      to: ['x'],
      subject: '',
      body: '',
    });
    request(s.outbox, 'b', { tool: 'format_disk' });
    expect((await result(s.outbox, 'a')).error).toBeDefined();
    expect((await result(s.outbox, 'b')).error).toBeDefined();
    expect(s.asked).toEqual([]);
    expect(s.calls).toEqual([]);
    s.stop();
  });
  it('a failed Microsoft call is reported, not hidden', async () => {
    const outbox = temp();
    const stop = watchOutbox(outbox, async () => true, {
      token: async () => 't',
      f: async () => new Response('{}', { status: 500 }),
      everyMs: 20,
    });
    request(outbox, 'a', { tool: 'mail_delete', id: 'm1' });
    expect((await result(outbox, 'a')).error as string).toContain('500');
    stop();
  });
});

describe('the helper process end to end', () => {
  it('lists its tools, reads nothing without a token, and a send waits for the card', async () => {
    const dir = temp();
    const out = join(dir, 'm365_mcp.cjs');
    buildSync({
      entryPoints: [resolve('src/core/m365/mcpServer.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out,
      logLevel: 'silent',
    });
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox);
    const tokenFile = join(dir, 'token.json');
    writeFileSync(tokenFile, JSON.stringify({ accessToken: 'T' }));
    const child = spawn(
      process.execPath,
      [out, '--agenthq-m365', '--token-file', tokenFile, '--outbox', outbox],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const replies = new Map<number, Record<string, unknown>>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = JSON.parse(line) as Record<string, unknown>;
      replies.set(Number(m.id), m);
    });
    const rpc = (id: number, method: string, params: unknown = {}) =>
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    const { f, calls } = fakeFetch();
    const asked: string[] = [];
    const stop = watchOutbox(
      outbox,
      async (card) => {
        asked.push(card.text);
        return card.text.includes('YES');
      },
      { token: async () => 'T', f, everyMs: 20 },
    );
    try {
      rpc(1, 'initialize', { protocolVersion: '2025-03-26' });
      rpc(2, 'tools/list');
      await vi.waitFor(() => expect(replies.has(2)).toBe(true));
      expect(
        (
          (replies.get(2)!.result as { tools: unknown[] }).tools as {
            name: string;
          }[]
        ).map((t) => t.name),
      ).toContain('mail_send');
      // A send is held for the card; Approve lets the plugin do it, Reject tells the agent.
      rpc(3, 'tools/call', {
        name: 'mail_send',
        arguments: { to: ['a@example.com'], subject: 's', body: 'YES please' },
      });
      rpc(4, 'tools/call', {
        name: 'mail_delete',
        arguments: { id: 'm1' },
      });
      await vi.waitFor(
        () => expect(replies.has(3) && replies.has(4)).toBe(true),
        {
          timeout: 8000,
        },
      );
      expect(JSON.stringify(replies.get(3))).toContain('The email was sent.');
      expect(JSON.stringify(replies.get(4))).toContain(
        'The owner rejected this action',
      );
      // Only the plugin's watcher made the write call; the helper made none itself.
      expect(
        calls.filter((c) => c.method !== 'GET').map((c) => c.method),
      ).toEqual(['POST']);
      // A bad request never reaches the outbox.
      rpc(5, 'tools/call', { name: 'mail_send', arguments: { to: ['bad'] } });
      await vi.waitFor(() => expect(replies.has(5)).toBe(true));
      expect(JSON.stringify(replies.get(5))).toContain('Invalid request');
      expect(asked).toHaveLength(2);
    } finally {
      stop();
      child.kill();
    }
  }, 30000);
});

describe('sign-in and token', () => {
  it('asks Microsoft for a device code with only the client id and scopes, for the chosen account type', async () => {
    const { f, calls } = fakeFetch({
      devicecode: {
        device_code: 'DC',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        interval: 5,
        expires_in: 900,
      },
    });
    const code = await startDeviceCode('cid', 'consumers', f);
    expect(code.userCode).toBe('ABCD-EFGH');
    expect(calls[0]!.url).toBe(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    );
    expect(calls[0]!.body).toContain('client_id=cid');
    expect(calls[0]!.body).not.toContain('secret');
    expect(decodeURIComponent(calls[0]!.body)).toContain('Mail.Send');
    expect(decodeURIComponent(calls[0]!.body)).not.toContain('.All');
    const bad = fakeFetch({
      devicecode: {
        error: 'unauthorized_client',
        error_description: 'AADSTS700038 not valid\r\nTrace',
      },
    });
    await expect(startDeviceCode('x', 'common', bad.f)).rejects.toThrow(
      /AADSTS700038 not valid$/,
    );
  });
  it('keeps the token outside any vault only after the owner finished signing in, and Disconnect removes it', async () => {
    const home = temp();
    let polls = 0;
    const f = (async (url: string) => {
      void url;
      polls++;
      return new Response(
        JSON.stringify(
          polls < 2
            ? { error: 'authorization_pending' }
            : { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        ),
      );
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    const done = finishDeviceCode(
      {
        userCode: 'u',
        verificationUri: 'v',
        deviceCode: 'd',
        intervalSeconds: 1,
        expiresInSeconds: 60,
      },
      'cid',
      'consumers',
      { home, f },
    );
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    vi.useRealTimers();
    expect(await isConnected(home)).toBe(true);
    await disconnect(home);
    expect(await isConnected(home)).toBe(false);
  });
  it('refreshes an expiring token and keeps the new refresh token; a refused refresh asks to sign in again', async () => {
    const home = temp();
    writeFileSync(
      join(home, 'microsoft365.json'),
      JSON.stringify({
        accessToken: 'OLD',
        refreshToken: 'RT1',
        expiresAt: Date.now() - 1000,
        clientId: 'cid',
        authority: 'consumers',
      }),
    );
    const { f, calls } = fakeFetch({
      '/token': { access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 },
    });
    expect(await accessToken({ home, f })).toBe('NEW');
    expect(calls[0]!.body).toContain('refresh_token=RT1');
    const saved = JSON.parse(
      readFileSync(join(home, 'microsoft365.json'), 'utf8'),
    ) as { refreshToken: string };
    expect(saved.refreshToken).toBe('RT2');
    // Still valid: no second call.
    expect(await accessToken({ home, f })).toBe('NEW');
    expect(calls).toHaveLength(1);
    writeFileSync(
      join(home, 'microsoft365.json'),
      JSON.stringify({
        accessToken: 'x',
        refreshToken: 'r',
        expiresAt: 0,
        clientId: 'cid',
        authority: 'consumers',
      }),
    );
    const refused = fakeFetch({ '/token': { error: 'invalid_grant' } });
    await expect(accessToken({ home, f: refused.f })).rejects.toThrow(
      /sign in again/,
    );
  });
});

describe('where Microsoft 365 is offered', () => {
  it('Claude Code, OpenCode and Hermes once connected; never Codex; never an unknown runtime', () => {
    for (const runtime of ['claude-code', 'opencode', 'hermes']) {
      expect(m365UnavailableReason(runtime, true)).toBe('');
      expect(m365UnavailableReason(runtime, false)).toMatch(
        /Connect Microsoft 365/,
      );
    }
    expect(m365UnavailableReason('codex', true)).toMatch(/whole computer/);
    expect(m365UnavailableReason('future', true)).toMatch(
      /cannot load exactly/,
    );
  });
  it('starts exactly the helper, with safe paths only', () => {
    const launch = {
      node: 'C:/node/node.exe',
      helper: 'C:/vault/plugin/m365_mcp.cjs',
      tokenFile: 'C:/tmp/run/token.json',
      outbox: 'C:/tmp/run/outbox',
    };
    const { command, args } = m365ServerCommand(launch);
    expect(command).toBe('C:/node/node.exe');
    expect(args.slice(0, 2)).toEqual([
      'C:/vault/plugin/m365_mcp.cjs',
      '--agenthq-m365',
    ]);
    expect(() => m365ServerCommand({ ...launch, outbox: '../x' })).toThrow(
      /Unsafe/,
    );
  });
});
