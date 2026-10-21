import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accessToken,
  accountLabel,
  M365_SCOPES,
  needsNewPermission,
  startDeviceCode,
} from '../src/core/m365/auth';
import { graph, graphErrorText } from '../src/core/m365/graph';

const home = () => mkdtempSync(join(tmpdir(), 'agenthq-signin-'));
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
/** A pretend Microsoft that answers every call with the given status and body, and records the calls. */
const answering = (status: number, body: unknown) => {
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    return json(body, status);
  }) as unknown as typeof fetch;
  return { f, calls };
};
const saveToken = (dir: string, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    join(dir, 'microsoft365.json'),
    JSON.stringify({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'cid',
      authority: 'consumers',
      ...extra,
    }),
  );

describe('the profile permission', () => {
  it('is asked for at sign-in, without any admin-only permission', async () => {
    expect(M365_SCOPES).toContain('User.Read');
    const { f, calls } = answering(200, {
      device_code: 'd',
      user_code: 'u',
      verification_uri: 'v',
    });
    await startDeviceCode('cid', 'consumers', f);
    expect(decodeURIComponent(calls[0]!.body)).toContain('User.Read');
    expect(M365_SCOPES).not.toContain('.All');
  });

  it('is missing from earlier sign-ins, which keep working but are told to sign in once more', async () => {
    const dir = home();
    saveToken(dir);
    expect(await needsNewPermission(dir)).toBe(true);
    saveToken(dir, { scope: M365_SCOPES });
    expect(await needsNewPermission(dir)).toBe(false);
  });

  it('is not requested when refreshing an earlier sign-in, so that sign-in is not broken', async () => {
    const dir = home();
    saveToken(dir, { expiresAt: 0 });
    const { f, calls } = answering(200, {
      access_token: 'NEW',
      refresh_token: 'RT2',
      expires_in: 3600,
    });
    expect(await accessToken({ home: dir, f })).toBe('NEW');
    expect(decodeURIComponent(calls[0]!.body)).not.toContain('User.Read');
    expect(decodeURIComponent(calls[0]!.body)).toContain('Mail.Send');
    const saved = JSON.parse(
      readFileSync(join(dir, 'microsoft365.json'), 'utf8'),
    ) as { scope?: string };
    expect(saved.scope).toBeUndefined();
  });
});

describe('the account label', () => {
  it('shows the name and address', async () => {
    const dir = home();
    saveToken(dir, { scope: M365_SCOPES });
    const { f } = answering(200, {
      displayName: 'Ana',
      userPrincipalName: 'ana@live.com.pt',
    });
    expect(await accountLabel({ home: dir, f })).toBe('Ana (ana@live.com.pt)');
  });

  it('is empty, not an error, when Microsoft answers 404 for /me', async () => {
    const dir = home();
    saveToken(dir, { scope: M365_SCOPES });
    const { f } = answering(404, {
      error: { code: 'MailboxNotEnabledForRESTAPI', message: 'no mailbox' },
    });
    expect(await accountLabel({ home: dir, f })).toBe('');
  });
});

describe('Graph errors in plain words', () => {
  it.each([
    [404, 'MailboxNotEnabledForRESTAPI', 'no Outlook mailbox'],
    [401, 'InvalidAuthenticationToken', 'Sign in again'],
    [403, 'ErrorAccessDenied', 'Permission not granted'],
  ])('%i %s says: %s, and keeps the code', (status, code, words) => {
    const text = graphErrorText(status, code, 'raw message');
    expect(text).toContain(words);
    expect(text).toContain(String(status));
    expect(text).toContain(code);
    expect(text).not.toContain('raw message');
  });

  it('keeps the old wording for other errors', async () => {
    expect(graphErrorText(500, 'Boom', 'It broke')).toBe(
      'Microsoft Graph answered 500: Boom It broke',
    );
    const { f } = answering(404, {
      error: { code: 'MailboxNotEnabledForRESTAPI', message: 'x' },
    });
    await expect(graph('T', 'GET', '/me/messages', { f })).rejects.toThrow(
      /no Outlook mailbox.*404.*MailboxNotEnabledForRESTAPI/,
    );
  });
});
