import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import {
  saveImageAttachment,
  acceptImageTransfer,
} from '../src/obsidian/images';
const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
function fixture() {
  const files = new Map<string, ArrayBuffer>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) =>
        folders.has(p) ? { path: p } : null,
      createFolder: vi.fn(async (p: string) => {
        folders.add(p);
      }),
      createBinary: vi.fn(async (p: string, b: ArrayBuffer) => {
        if (files.has(p)) throw Error('exists');
        files.set(p, b);
        return { path: p };
      }),
      getResourcePath: (f: { path: string }) => 'app://' + f.path,
    },
  };
  return { app: app as unknown as App, files, raw: app };
}
const file = () =>
  ({
    type: 'image/png',
    size: 8,
    arrayBuffer: async () => bytes.slice().buffer,
  }) as File;
it('writes unique image files through Vault and returns resource URLs', async () => {
  const { app, files } = fixture();
  const a = await saveImageAttachment(app, 'HQ', file());
  const b = await saveImageAttachment(app, 'HQ', file());
  expect(a.path).toMatch(/^HQ\/Attachments\/image-.*\.png$/);
  expect(a.path).not.toBe(b.path);
  expect(a.url).toBe('app://' + a.path);
  expect([...files.values()].map((b) => [...new Uint8Array(b)])).toEqual([
    [...bytes],
    [...bytes],
  ]);
});
it('refuses oversized files before reading or touching Vault', async () => {
  const { app, raw } = fixture();
  const arrayBuffer = vi.fn();
  await expect(
    saveImageAttachment(app, 'HQ', {
      type: 'image/png',
      size: 10 * 1024 * 1024 + 1,
      arrayBuffer,
    } as unknown as File),
  ).rejects.toThrow('10 MB');
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(raw.vault.createBinary).not.toHaveBeenCalled();
});
it.each(['paste', 'drop'])(
  '%s saves files, reports invalid files, and leaves ordinary text transfers alone',
  async () => {
    const save = vi.fn(async () => ({
      path: 'HQ/Attachments/image-1.png',
      url: 'app://img',
    }));
    const accepted = vi.fn();
    const report = vi.fn();
    const preventDefault = vi.fn();
    await acceptImageTransfer([file()], preventDefault, save, accepted, report);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    await acceptImageTransfer([], preventDefault, save, accepted, report);
    expect(save).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => {
      throw Error('Only images');
    });
    await acceptImageTransfer(
      [{} as File],
      preventDefault,
      bad,
      accepted,
      report,
    );
    expect(report).toHaveBeenCalledWith('Only images');
  },
);
