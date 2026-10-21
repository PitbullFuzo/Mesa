import { expect, it, vi } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import { FakeRuntime } from '../src/core/runtimes/fake';

it('uses host link text for task fields, results and monthly activity', async () => {
  const store = new MemoryStore();
  const lead = await store.createAgent('Lead');
  const worker = await store.createAgent('Worker');
  await store.patchAgent(lead, { runtime: 'fake' });
  await store.patchAgent(worker, { runtime: 'fake' });
  await store.setManager(worker, lead);
  const runtime = new FakeRuntime((req) => [
    {
      type: 'done',
      isError: false,
      text:
        req.prompt === 'delegate'
          ? '```agenthq-delegate\n{"tasks":[{"to":"Worker","task":"Say done"}]}\n```'
          : 'Done',
    },
  ]);
  const noteLink = vi.fn(
    async (path: string, _source: string) =>
      `[[${path.split('/').at(-1)!.replace(/\.md$/, '')}]]`,
  );
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: [] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    noteLink,
  });
  await service.initialize();
  await service.send(lead, 'delegate');
  const task = (await store.loadTasks())[0]!;
  expect(task.frontmatter).toMatchObject({
    from: '[[Lead]]',
    to: '[[Worker]]',
  });
  const activity = (await store.loadActivity())[0]!;
  expect(activity.body).toContain('[[Lead]] delegated');
  expect(activity.body).toContain('to [[Worker]]');
  expect(activity.body).not.toContain('[[Obi-I/');
  expect(
    noteLink.mock.calls.some(([, source]) =>
      source.startsWith('Obi-I/Activity/'),
    ),
  ).toBe(true);
  expect(runtime.requests.at(-1)!.prompt).toContain(`[[${task.name}]]`);
  await service.dispose();
});
