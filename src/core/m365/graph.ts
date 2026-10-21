/** Plain Microsoft Graph calls (v1.0). Reads run in the helper; actions run only in the plugin, after an approved card. */
export type Fetch = typeof fetch;

/** Text for display: strings and numbers as they are, anything else as the fallback. */
export const txt = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Plain words for the Graph errors owners meet most. The status and code are always kept after them. */
export function graphErrorText(
  status: number,
  code: string,
  message: string,
): string {
  const plain =
    code === 'MailboxNotEnabledForRESTAPI' ||
    code === 'MailboxNotSupportedForRESTAPI'
      ? 'This Microsoft account has no Outlook mailbox'
      : status === 401
        ? 'Sign in again (Settings → Connectors)'
        : status === 403
          ? 'Permission not granted: sign in again and approve'
          : '';
  const detail = `${code} ${message}`.trim();
  return plain
    ? `${plain} (Microsoft Graph ${status}${code ? ` ${code}` : ''})`
    : `Microsoft Graph answered ${status}${detail ? `: ${detail}` : ''}`;
}
const MAX_TEXT = 60_000;

export async function graph(
  token: string,
  method: string,
  path: string,
  options: {
    body?: unknown;
    text?: string;
    headers?: Record<string, string>;
    f?: Fetch;
    raw?: boolean;
  } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...options.headers,
  };
  let body: string | undefined;
  if (options.text !== undefined) {
    headers['Content-Type'] = 'text/plain';
    body = options.text;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  // The helper runs in plain Node, where the global fetch is right; the plugin always passes its own `f`.
  const response = await (options.f ?? globalThis.fetch)(GRAPH + path, {
    method,
    headers,
    body,
  });
  if (!response.ok) {
    // Never echo the response body of a failed call into an agent's context beyond Microsoft's own error text.
    let code = '';
    let message = '';
    try {
      const parsed = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      code = parsed.error?.code ?? '';
      message = parsed.error?.message ?? '';
    } catch {
      /* No JSON body. */
    }
    throw new Error(graphErrorText(response.status, code, message));
  }
  if (options.raw) {
    const text = await response.text();
    return text.length > MAX_TEXT
      ? text.slice(0, MAX_TEXT) + '\n[cut: file is longer]'
      : text;
  }
  if (response.status === 204 || response.status === 202) return {};
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : {};
}

const enc = encodeURIComponent;
/** A OneDrive path ("Documents/a.txt") as a Graph path segment. */
const drivePath = (path: string) =>
  path.replace(/^\/+/, '').split('/').map(enc).join('/');

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => {
  const value = record(v).value;
  return Array.isArray(value) ? value : [];
};
const address = (v: unknown) => {
  const email = record(record(v).emailAddress);
  return `${txt(email.name)} <${txt(email.address)}>`.trim();
};

export interface Reads {
  mailSearch(args: {
    query?: string;
    folder?: string;
    top?: number;
  }): Promise<string>;
  mailRead(id: string): Promise<string>;
  calendarList(start: string, end: string): Promise<string>;
  filesList(path?: string): Promise<string>;
  fileRead(args: { id?: string; path?: string }): Promise<string>;
  mailDraft(args: {
    to: string[];
    subject: string;
    body: string;
  }): Promise<string>;
}

/** The read tools (and the harmless "create a draft"), bound to one token source. */
export function reads(token: () => Promise<string>, f?: Fetch): Reads {
  const call = async (
    method: string,
    path: string,
    options: Parameters<typeof graph>[3] = {},
  ) => graph(await token(), method, path, { f, ...options });
  return {
    async mailSearch({ query, folder, top }) {
      const where = folder
        ? `/me/mailFolders/${enc(folder)}/messages`
        : '/me/messages';
      const q = new URLSearchParams({
        $top: String(Math.min(Math.max(top ?? 10, 1), 25)),
        $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
      });
      if (query) q.set('$search', `"${query.replace(/"/g, '')}"`);
      else q.set('$orderby', 'receivedDateTime desc');
      const result = await call('GET', `${where}?${q.toString()}`);
      return (
        list(result)
          .map((m) => {
            const mail = record(m);
            return `id: ${String(mail.id)}\nfrom: ${address(mail.from)}\ndate: ${String(mail.receivedDateTime)}\nsubject: ${String(mail.subject)}\npreview: ${txt(mail.bodyPreview).slice(0, 200)}`;
          })
          .join('\n---\n') || 'No messages.'
      );
    },
    async mailRead(id) {
      const mail = record(
        await call(
          'GET',
          `/me/messages/${enc(id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body`,
          { headers: { Prefer: 'outlook.body-content-type="text"' } },
        ),
      );
      const names = (v: unknown) =>
        (Array.isArray(v) ? v : []).map(address).join(', ');
      const body = txt(record(mail.body).content);
      return `from: ${address(mail.from)}\nto: ${names(mail.toRecipients)}\ncc: ${names(mail.ccRecipients)}\ndate: ${String(mail.receivedDateTime)}\nsubject: ${String(mail.subject)}\n\n${body.length > MAX_TEXT ? body.slice(0, MAX_TEXT) + '\n[cut]' : body}`;
    },
    async calendarList(start, end) {
      const q = new URLSearchParams({
        startDateTime: start,
        endDateTime: end,
        $top: '50',
        $orderby: 'start/dateTime',
        $select: 'id,subject,start,end,location,organizer,bodyPreview',
      });
      const result = await call('GET', `/me/calendarView?${q.toString()}`, {
        headers: { Prefer: 'outlook.timezone="UTC"' },
      });
      return (
        list(result)
          .map((e) => {
            const ev = record(e);
            return `id: ${String(ev.id)}\n${String(record(ev.start).dateTime)} to ${String(record(ev.end).dateTime)} (UTC)\n${String(ev.subject)}\nlocation: ${txt(record(ev.location).displayName)}\norganizer: ${address(ev.organizer)}`;
          })
          .join('\n---\n') || 'No events.'
      );
    },
    async filesList(path) {
      const where = path
        ? `/me/drive/root:/${drivePath(path)}:/children`
        : '/me/drive/root/children';
      const result = await call(
        'GET',
        `${where}?$top=100&$select=id,name,size,lastModifiedDateTime,folder,file`,
      );
      return (
        list(result)
          .map((i) => {
            const item = record(i);
            return `${item.folder ? '[folder]' : '[file]'} ${String(item.name)} (id ${String(item.id)}, ${txt(item.size) || '0'} bytes, ${String(item.lastModifiedDateTime)})`;
          })
          .join('\n') || 'Empty folder.'
      );
    },
    async fileRead({ id, path }) {
      if (!id && !path) throw new Error('Give a file id or a path.');
      const where = id
        ? `/me/drive/items/${enc(id)}/content`
        : `/me/drive/root:/${drivePath(path!)}:/content`;
      return (await call('GET', where, { raw: true })) as string;
    },
    async mailDraft({ to, subject, body }) {
      const draft = record(
        await call('POST', '/me/messages', {
          body: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
          },
        }),
      );
      return `Draft created in the owner's Drafts folder (id ${String(draft.id)}). Nothing was sent.`;
    },
  };
}
