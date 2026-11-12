import type { Store } from './store';

const pad = (value: number) => String(value).padStart(2, '0');

/** The month's Activity note: `<root>/Activity/YYYY-MM.md`. */
export function activityNotePath(root: string, now = new Date()): string {
  return `${root}/Activity/${now.getFullYear()}-${pad(now.getMonth() + 1)}.md`;
}

/** One Activity line: `- YYYY-MM-DD HH:MM text`. */
export function activityLine(text: string, now = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `- ${date} ${pad(now.getHours())}:${pad(now.getMinutes())} ${text}`;
}

/** Every Activity write waits for the one before it, so two lines written at the same moment never overwrite each other. */
let writes: Promise<void> = Promise.resolve();

/** Appends one line to the month's Activity note, creating it when needed. Only this month's note is read. */
export function appendActivityLine(
  store: Store,
  root: string,
  text: string,
  now = new Date(),
): Promise<void> {
  const write = writes.then(() => appendNow(store, root, text, now));
  writes = write.catch(() => {});
  return write;
}

async function appendNow(
  store: Store,
  root: string,
  text: string,
  now: Date,
): Promise<void> {
  const folder = `${root}/Activity`;
  if (!(await store.exists(folder))) {
    try {
      await store.createFolder(folder);
    } catch (error) {
      if (!(await store.exists(folder))) throw error;
    }
  }
  const path = activityNotePath(root, now);
  const existing = await store.loadNote(path);
  await store.saveNote(
    path,
    (existing?.frontmatter as Record<string, unknown> | undefined) ?? {
      agenthq: 'activity',
    },
    `${existing?.body ? existing.body.trimEnd() + '\n' : ''}${activityLine(text, now)}\n`,
  );
}
