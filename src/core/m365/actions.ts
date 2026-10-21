import { z } from 'zod';
import { graph, txt, type Fetch } from './graph';

const email = z.email();
const id = z.string().trim().min(1).max(512);
/** A OneDrive path: plain folders and a file name, no traversal. */
const path = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (p) => !p.split(/[\\/]/).some((part) => part === '..' || part === '.'),
    'No . or .. in a path',
  );

/**
 * Everything an agent can ask for that sends something out, deletes, shares or writes a file. The helper only writes
 * these as requests; the plugin runs one only after the owner approves a card showing all of it.
 */
export const actionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('mail_send'),
    to: z.array(email).min(1).max(20),
    cc: z.array(email).max(20).optional(),
    subject: z.string().max(500),
    body: z.string().max(100_000),
  }),
  z.object({ tool: z.literal('mail_send_draft'), id }),
  z.object({
    tool: z.literal('mail_reply'),
    id,
    body: z.string().max(100_000),
    all: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal('mail_forward'),
    id,
    to: z.array(email).min(1).max(20),
    comment: z.string().max(100_000).optional(),
  }),
  z.object({ tool: z.literal('mail_delete'), id }),
  z.object({
    tool: z.literal('event_create'),
    subject: z.string().max(500),
    start: z.string().max(40),
    end: z.string().max(40),
    attendees: z.array(email).max(50).optional(),
    body: z.string().max(100_000).optional(),
  }),
  z.object({
    tool: z.literal('event_respond'),
    id,
    response: z.enum(['accept', 'decline', 'tentative']),
    comment: z.string().max(10_000).optional(),
  }),
  z.object({
    tool: z.literal('file_share'),
    id,
    type: z.enum(['view', 'edit']),
    scope: z.enum(['organization', 'anonymous']),
  }),
  z.object({
    tool: z.literal('file_write'),
    path,
    content: z.string().max(200_000),
  }),
]);
export type Action = z.infer<typeof actionSchema>;

export const ACTION_TOOLS = actionSchema.options.map(
  (option) => option.shape.tool.value,
);

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const enc = encodeURIComponent;
const drivePath = (p: string) =>
  p
    .replace(/^[\\/]+/, '')
    .split(/[\\/]/)
    .map(enc)
    .join('/');

export interface ActionCard {
  title: string;
  /** The full content the owner is approving. */
  text: string;
}

const TITLES: Record<Action['tool'], string> = {
  mail_send: 'Send an email',
  mail_send_draft: 'Send a draft email',
  mail_reply: 'Reply to an email',
  mail_forward: 'Forward an email',
  mail_delete: 'Delete an email',
  event_create: 'Create a calendar event (invitations are sent to attendees)',
  event_respond: 'Answer a calendar invitation (the organizer is told)',
  file_share: 'Share a OneDrive file with a link',
  file_write: 'Write a OneDrive file (replaces it if it exists)',
};

/** What the card shows, from the validated request itself; `extra` adds what Microsoft says about the target. */
export function describeAction(action: Action, extra = ''): ActionCard {
  const lines: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined && value !== '') lines.push(`${label}: ${value}`);
  };
  switch (action.tool) {
    case 'mail_send':
      add('To', action.to.join(', '));
      add('Cc', action.cc?.join(', '));
      add('Subject', action.subject);
      lines.push('', action.body);
      break;
    case 'mail_send_draft':
    case 'mail_delete':
      add('Message', extra || action.id);
      break;
    case 'mail_reply':
      add('Replying to', extra || action.id);
      add('Reply to everyone', action.all ? 'yes' : 'no');
      lines.push('', action.body);
      break;
    case 'mail_forward':
      add('Forwarding', extra || action.id);
      add('To', action.to.join(', '));
      lines.push('', action.comment ?? '');
      break;
    case 'event_create':
      add('Subject', action.subject);
      add('Start', action.start);
      add('End', action.end);
      add('Attendees', action.attendees?.join(', '));
      lines.push('', action.body ?? '');
      break;
    case 'event_respond':
      add('Event', extra || action.id);
      add('Answer', action.response);
      add('Comment', action.comment);
      break;
    case 'file_share':
      add('File', extra || action.id);
      add('Link gives', action.type === 'edit' ? 'view and edit' : 'view');
      add(
        'Who can use it',
        action.scope === 'anonymous'
          ? 'anyone who has the link'
          : 'people in your organisation',
      );
      break;
    case 'file_write':
      add('Path', action.path);
      lines.push('', action.content);
      break;
  }
  return { title: TITLES[action.tool], text: lines.join('\n') };
}

/** Best-effort: names the message, event or file an action points at, so the card is not just an id. */
export async function summarizeTarget(
  action: Action,
  token: string,
  f: Fetch,
): Promise<string> {
  try {
    if ('id' in action && action.tool.startsWith('mail_')) {
      const mail = record(
        await graph(
          token,
          'GET',
          `/me/messages/${enc(action.id)}?$select=subject,from`,
          { f },
        ),
      );
      const from = record(record(mail.from).emailAddress);
      return `"${String(mail.subject)}" from ${txt(from.name)} <${txt(from.address)}>`;
    }
    if (action.tool === 'event_respond') {
      const ev = record(
        await graph(
          token,
          'GET',
          `/me/events/${enc(action.id)}?$select=subject,start`,
          { f },
        ),
      );
      return `"${String(ev.subject)}" at ${String(record(ev.start).dateTime)}`;
    }
    if (action.tool === 'file_share') {
      const item = record(
        await graph(
          token,
          'GET',
          `/me/drive/items/${enc(action.id)}?$select=name,parentReference`,
          { f },
        ),
      );
      return `${txt(record(item.parentReference).path)}/${String(item.name)}`;
    }
  } catch {
    /* The card falls back to the id. */
  }
  return '';
}

/** Runs one approved action. Called only by the plugin, with its own token. */
export async function executeAction(
  action: Action,
  token: string,
  f: Fetch,
): Promise<string> {
  const to = (list: string[]) =>
    list.map((address) => ({ emailAddress: { address } }));
  const call = (
    method: string,
    p: string,
    options: Omit<Parameters<typeof graph>[3], 'f'> = {},
  ) => graph(token, method, p, { f, ...options });
  switch (action.tool) {
    case 'mail_send':
      await call('POST', '/me/sendMail', {
        body: {
          message: {
            subject: action.subject,
            body: { contentType: 'Text', content: action.body },
            toRecipients: to(action.to),
            ccRecipients: to(action.cc ?? []),
          },
          saveToSentItems: true,
        },
      });
      return 'The email was sent.';
    case 'mail_send_draft':
      await call('POST', `/me/messages/${enc(action.id)}/send`);
      return 'The draft was sent.';
    case 'mail_reply':
      await call(
        'POST',
        `/me/messages/${enc(action.id)}/${action.all ? 'replyAll' : 'reply'}`,
        { body: { comment: action.body } },
      );
      return 'The reply was sent.';
    case 'mail_forward':
      await call('POST', `/me/messages/${enc(action.id)}/forward`, {
        body: { comment: action.comment ?? '', toRecipients: to(action.to) },
      });
      return 'The email was forwarded.';
    case 'mail_delete':
      await call('DELETE', `/me/messages/${enc(action.id)}`);
      return 'The email was deleted.';
    case 'event_create':
      await call('POST', '/me/events', {
        body: {
          subject: action.subject,
          start: { dateTime: action.start, timeZone: 'UTC' },
          end: { dateTime: action.end, timeZone: 'UTC' },
          attendees: (action.attendees ?? []).map((address) => ({
            emailAddress: { address },
            type: 'required',
          })),
          body: { contentType: 'Text', content: action.body ?? '' },
        },
      });
      return 'The event was created.';
    case 'event_respond':
      await call(
        'POST',
        `/me/events/${enc(action.id)}/${action.response === 'tentative' ? 'tentativelyAccept' : action.response === 'accept' ? 'accept' : 'decline'}`,
        { body: { comment: action.comment ?? '', sendResponse: true } },
      );
      return `The invitation was answered: ${action.response}.`;
    case 'file_share': {
      const result = record(
        await call('POST', `/me/drive/items/${enc(action.id)}/createLink`, {
          body: { type: action.type, scope: action.scope },
        }),
      );
      return `The link was created: ${String(record(result.link).webUrl)}`;
    }
    case 'file_write':
      await call('PUT', `/me/drive/root:/${drivePath(action.path)}:/content`, {
        text: action.content,
      });
      return 'The file was written.';
  }
}
