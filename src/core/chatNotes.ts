import { chatExcerpt } from './mentions';
import type { ChatEntry } from './chat';
import type { NoteDocument } from './notes';

export function localTime(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Claude-style title: the first eight words of the first message, no AI call. */
export function chatTitle(text: string): string {
  return text.trim().split(/\s+/).slice(0, 8).join(' ');
}

/** New notes are named "<title> — <agent> — YYYY-MM-DD HHMM". */
export function chatBasename(
  started: string,
  agentName: string,
  title: string,
): string {
  const date = new Date(started);
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const safe = (value: string) =>
    Array.from(value)
      .filter((character) => character.charCodeAt(0) >= 32)
      .join('')
      .replace(/[<>:"/\\|?*#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80);
  return `${safe(title) || 'New conversation'} — ${safe(agentName)} — ${day} ${localTime(started).replace(':', '')}`;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Saved title, or the first message for notes made before titles existed. */
export function conversationTitle(note: NoteDocument): string {
  const fm = record(note.frontmatter);
  if (typeof fm.title === 'string' && fm.title) return fm.title;
  const first = readMessages(note.body).find(
    (message) => message.role === 'user',
  );
  return (first && chatTitle(first.content)) || note.name;
}

/** A chat note as an @mention attaches it: its title and its last messages. */
export function chatMention(note: NoteDocument): {
  content: string;
  truncated: boolean;
} {
  return chatExcerpt(conversationTitle(note), readMessages(note.body));
}

/** Hidden per-message metadata makes arbitrary Markdown unambiguous without duplicating text in frontmatter. */
export function readMessages(body: string): ChatEntry[] {
  const messages: ChatEntry[] = [];
  const marker = /^<!-- agenthq-message (.+) -->\n### [^\n]*\n\n/gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(body))) {
    try {
      const metadata = record(JSON.parse(match[1]!));
      const length = metadata.contentLength;
      if (
        (metadata.role !== 'user' && metadata.role !== 'assistant') ||
        typeof metadata.timestamp !== 'string' ||
        typeof length !== 'number' ||
        !Number.isInteger(length) ||
        length < 0 ||
        marker.lastIndex + length > body.length
      )
        continue;
      const tools = Array.isArray(metadata.tools)
        ? metadata.tools.flatMap((item: unknown) => {
            const tool = record(item);
            return typeof tool.name === 'string' &&
              typeof tool.summary === 'string'
              ? [{ name: tool.name, summary: tool.summary }]
              : [];
          })
        : [];
      messages.push({
        role: metadata.role,
        timestamp: metadata.timestamp,
        content: body.slice(marker.lastIndex, marker.lastIndex + length),
        tools,
        ...(typeof metadata.costUsd === 'number'
          ? { costUsd: metadata.costUsd }
          : {}),
        ...(typeof metadata.tokens === 'number'
          ? { tokens: metadata.tokens }
          : {}),
        ...(metadata.cancelled === true ? { cancelled: true } : {}),
      });
      marker.lastIndex +=
        length +
        (typeof metadata.tailLength === 'number' && metadata.tailLength >= 0
          ? metadata.tailLength
          : 0);
    } catch {
      /* Malformed manually edited history must not prevent startup. */
    }
  }
  if (messages.length) return messages;
  return [
    ...body.matchAll(
      /^### (.+?) · ([^\n]+)\n\n([\s\S]*?)(?=\n\n### |\n\n## Summary|$)/gm,
    ),
  ].map((match) => ({
    role: match[1] === 'You' ? 'user' : 'assistant',
    timestamp: match[2]!,
    content: match[3]!,
    tools: [],
  }));
}
