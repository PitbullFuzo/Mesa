import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { WorkspaceActions } from '../src/core/workspace';
import type { AgentChatSnapshot } from '../src/core/chat';
import { ChatContent } from '../src/obsidian/views/chatContent';
import { BroadcastBar } from '../src/obsidian/views/broadcastBar';
import { AttachmentPreviews } from '../src/obsidian/views/imageInput';

vi.mock('obsidian', () => ({
  FuzzySuggestModal: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Setting: class {},
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useLayoutEffect: () => {},
  useSyncExternalStore: (_s: unknown, get: () => unknown) => get(),
}));
vi.mock('../src/obsidian/views/markdownContent', () => ({
  MarkdownContent: () => null,
}));
function findForm(
  node: unknown,
): { onPaste: (e: unknown) => void; onDrop: (e: unknown) => void } | undefined {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: string; props?: { children?: unknown } };
  if (n.type === 'form') return n.props as ReturnType<typeof findForm>;
  const children = n.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const form = findForm(child);
    if (form) return form;
  }
  return undefined;
}
it.each(['chat', 'broadcast'])(
  '%s form wires both paste and drop to image saving',
  async (kind) => {
    const saveImage = vi.fn(async () => ({
      path: 'HQ/Attachments/image-1.png',
      url: 'app://image',
    }));
    const workspace = {
      saveImage,
      getSnapshot: () => ({ agents: [], groups: [], loading: false }),
      subscribe: () => () => {},
    } as unknown as WorkspaceActions;
    const chat = {
      status: 'idle',
      messages: [],
      agent: { name: 'A' },
    } as unknown as AgentChatSnapshot;
    const tree =
      kind === 'chat'
        ? ChatContent({ app: {} as App, workspace, chat, id: 'a' })
        : BroadcastBar({ workspace });
    const form = findForm(tree)!;
    expect(form).toBeDefined();
    const file = {} as File;
    const preventDefault = vi.fn();
    form.onPaste({ clipboardData: { files: [file] }, preventDefault });
    await vi.waitFor(() => expect(saveImage).toHaveBeenCalledTimes(1));
    form.onDrop({ dataTransfer: { files: [file] }, preventDefault });
    await vi.waitFor(() => expect(saveImage).toHaveBeenCalledTimes(2));
    expect(preventDefault).toHaveBeenCalledTimes(2);
  },
);
it('renders bounded, removable preview thumbnails without exposing original HTML filenames', () => {
  const html = renderToStaticMarkup(
    createElement(AttachmentPreviews, {
      images: [{ path: 'HQ/Attachments/image-1.png', url: 'app://image' }],
      onRemove: () => {},
    }),
  );
  expect(html).toContain('<img');
  expect(html).toContain('src="app://image"');
  expect(html).toContain('Remove image-1.png');
});
