import type { Store } from './store';

/** Appends one line to the month's Activity note, creating it when needed. */
export async function appendActivityLine(
  store: Store,
  root: string,
  text: string,
  now = new Date(),
): Promise<void> {
  const pad = (value: number) => String(value).padStart(2, '0');
  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const folder = `${root}/Activity`;
  if (!(await store.exists(folder))) await store.createFolder(folder);
  const path = `${folder}/${month}.md`;
  const existing = (await store.loadActivity()).find(
    (note) => note.path === path,
  );
  await store.saveNote(
    path,
    (existing?.frontmatter as Record<string, unknown> | undefined) ?? {
      agenthq: 'activity',
    },
    `${existing?.body ? existing.body.trimEnd() + '\n' : ''}- ${time} ${text}\n`,
  );
}
