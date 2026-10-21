/* eslint obsidianmd/prefer-window-timers: off -- Pure core runs in Node (tests, the helper process) where there is no window. */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { graph, txt, type Fetch } from './graph';

/**
 * Microsoft sign-in by the OAuth device-code grant: the owner types a code on Microsoft's own page in their own
 * browser. Mesa never sees a password. Tokens are kept outside the vault, in a file only this module reads.
 */
export const M365_SCOPES =
  'offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite';
/** What sign-ins made before User.Read was added were granted; refreshing asks for no more than this. */
const EARLIER_SCOPES = M365_SCOPES.replace(' User.Read', '');
/** The app registration used when the Settings field is empty, so owners just press Sign in. */
export const DEFAULT_M365_CLIENT_ID = 'b4b08f10-f311-4536-a773-f9fdca1810f9';
export type Authority = 'consumers' | 'common';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  clientId: string;
  authority: Authority;
  /** The permissions asked for at sign-in. Missing in sign-ins made before User.Read was added. */
  scope?: string;
}

export function m365Home(): string {
  return join(
    process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
    'Mesa',
    'connectors',
  );
}
const tokenFile = (home: string) => join(home, 'microsoft365.json');

const endpoint = (authority: Authority, name: 'devicecode' | 'token') =>
  `https://login.microsoftonline.com/${authority}/oauth2/v2.0/${name}`;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

async function post(
  url: string,
  fields: Record<string, string>,
  f: Fetch,
): Promise<Record<string, unknown>> {
  const response = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return record(await response.json());
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export async function startDeviceCode(
  clientId: string,
  authority: Authority,
  f: Fetch,
): Promise<DeviceCode> {
  const result = await post(
    endpoint(authority, 'devicecode'),
    { client_id: clientId, scope: M365_SCOPES },
    f,
  );
  if (typeof result.device_code !== 'string')
    throw new Error(
      `Microsoft did not start the sign-in: ${txt(result.error_description) || txt(result.error) || 'unknown error'}`.split(
        '\r\n',
      )[0],
    );
  return {
    userCode: String(result.user_code),
    verificationUri: String(result.verification_uri),
    deviceCode: result.device_code,
    intervalSeconds: Number(result.interval) || 5,
    expiresInSeconds: Number(result.expires_in) || 900,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Waits for the owner to finish signing in on Microsoft's page, then keeps the tokens. */
export async function finishDeviceCode(
  code: DeviceCode,
  clientId: string,
  authority: Authority,
  options: { home?: string; f: Fetch; signal?: AbortSignal },
): Promise<void> {
  const f = options.f;
  const deadline = Date.now() + code.expiresInSeconds * 1000;
  let interval = code.intervalSeconds;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, options.signal);
    if (options.signal?.aborted) throw new Error('Sign-in cancelled.');
    const result = await post(
      endpoint(authority, 'token'),
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: code.deviceCode,
      },
      f,
    );
    if (typeof result.access_token === 'string') {
      await saveTokens(options.home ?? m365Home(), {
        accessToken: result.access_token,
        refreshToken: txt(result.refresh_token),
        expiresAt: Date.now() + Number(result.expires_in) * 1000,
        clientId,
        authority,
        scope: M365_SCOPES,
      });
      return;
    }
    if (result.error === 'slow_down') interval += 5;
    else if (result.error !== 'authorization_pending')
      throw new Error(
        `Sign-in failed: ${String(result.error_description ?? result.error)}`.split(
          '\r\n',
        )[0],
      );
  }
  throw new Error('The sign-in code expired. Start again.');
}

async function saveTokens(home: string, tokens: Tokens): Promise<void> {
  await mkdir(home, { recursive: true });
  const file = tokenFile(home);
  await writeFile(file, JSON.stringify(tokens), { mode: 0o600 });
  // On Windows chmod only toggles read-only; the folder sits under the user's own profile.
  await chmod(file, 0o600).catch(() => {});
}

async function loadTokens(home: string): Promise<Tokens | undefined> {
  try {
    const parsed = record(JSON.parse(await readFile(tokenFile(home), 'utf8')));
    if (
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.clientId === 'string'
    )
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: Number(parsed.expiresAt) || 0,
        clientId: parsed.clientId,
        authority: parsed.authority === 'common' ? 'common' : 'consumers',
        scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      };
  } catch {
    /* Not signed in. */
  }
  return undefined;
}

export async function isConnected(home = m365Home()): Promise<boolean> {
  return (await loadTokens(home)) !== undefined;
}

/** True for a sign-in made before the profile permission (User.Read) was requested: it works, but the owner should sign in once more. */
export async function needsNewPermission(home = m365Home()): Promise<boolean> {
  const tokens = await loadTokens(home);
  return tokens !== undefined && !tokens.scope?.includes('User.Read');
}

/** Disconnect: removes the local token. Access granted at Microsoft stays until the owner removes it there. */
export async function disconnect(home = m365Home()): Promise<void> {
  await rm(tokenFile(home), { force: true });
}

let refreshing: Promise<string> | undefined;

/** A valid access token, refreshed when it is about to expire. Only the plugin calls this. */
export function accessToken(options: {
  home?: string;
  f: Fetch;
}): Promise<string> {
  const home = options.home ?? m365Home();
  const f = options.f;
  refreshing ??= (async () => {
    const tokens = await loadTokens(home);
    if (!tokens) throw new Error('Microsoft 365 is not connected.');
    if (tokens.expiresAt - Date.now() > 5 * 60_000) return tokens.accessToken;
    const result = await post(
      endpoint(tokens.authority, 'token'),
      {
        grant_type: 'refresh_token',
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope ?? EARLIER_SCOPES,
      },
      f,
    );
    if (typeof result.access_token !== 'string')
      throw new Error(
        'Microsoft 365 needs you to sign in again (Settings → Connectors).',
      );
    await saveTokens(home, {
      ...tokens,
      accessToken: result.access_token,
      refreshToken:
        typeof result.refresh_token === 'string'
          ? result.refresh_token
          : tokens.refreshToken,
      expiresAt: Date.now() + Number(result.expires_in) * 1000,
    });
    return result.access_token;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/**
 * The signed-in account's name and address, for Settings. The label is cosmetic: when Microsoft will not give it
 * (no profile permission yet, no mailbox), the connection stays and the label is empty.
 */
export async function accountLabel(options: {
  home?: string;
  f: Fetch;
}): Promise<string> {
  const token = await accessToken(options);
  try {
    const me = record(
      await graph(
        token,
        'GET',
        '/me?$select=displayName,mail,userPrincipalName',
        { f: options.f },
      ),
    );
    const name = txt(me.displayName);
    const address = txt(me.mail) || txt(me.userPrincipalName);
    return name && address ? `${name} (${address})` : name || address;
  } catch {
    return '';
  }
}
