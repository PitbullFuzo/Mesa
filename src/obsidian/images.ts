import type { App } from 'obsidian';
import { randomUUID } from 'node:crypto';
import {
  MAX_IMAGE_BYTES,
  validateImage,
  type ImageAttachment,
} from '../core/images';
import { managedPath } from '../core/paths';

export async function saveImageAttachment(
  app: App,
  root: string,
  file: File,
): Promise<ImageAttachment> {
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error('Images must be 10 MB or smaller.');
  const bytes = await file.arrayBuffer();
  const extension = validateImage(file, new Uint8Array(bytes));
  const folder = managedPath(root, `${root}/Attachments`);
  if (!app.vault.getAbstractFileByPath(folder)) {
    try {
      await app.vault.createFolder(folder);
    } catch (error) {
      if (!app.vault.getAbstractFileByPath(folder)) throw error;
    }
  }
  const path = managedPath(
    root,
    `${folder}/image-${randomUUID()}.${extension}`,
  );
  const saved = await app.vault.createBinary(path, bytes);
  return { path: saved.path, url: app.vault.getResourcePath(saved) };
}

/** Shared paste/drop boundary; ordinary text pastes retain native textarea behavior. */
export async function acceptImageTransfer(
  files: File[],
  preventDefault: () => void,
  save: (file: File) => Promise<ImageAttachment>,
  accept: (image: ImageAttachment) => void,
  report: (message: string) => void,
): Promise<void> {
  if (!files.length) return;
  preventDefault();
  for (const file of files) {
    try {
      accept(await save(file));
    } catch (error) {
      report(
        error instanceof Error ? error.message : 'Could not attach image.',
      );
    }
  }
}
