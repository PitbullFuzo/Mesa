import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  chatFacts,
  projectSpendUsd,
  taskFacts,
} from '../src/core/projectBoard';
import {
  createProjectNote,
  loadValidProjects,
  updateProjectNote,
} from '../src/core/projects';
import { FakeRuntime } from '../src/core/runtimes/fake';
import type { Project } from '../src/core/projects';

const paid = (text: string, costUsd: number) => [
  { type: 'done' as const, text, isError: false, costUsd },
];

async function setup(costLimitUsd?: number) {
  const store = new MemoryStore('Mesa');
  const coder = await store.createAgent('Coder');
  await store.patchAgent(coder, { runtime: 'fake' });
  const runtime = new FakeRuntime(() => paid('ok', 0.6), 0);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Mesa/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  await createProjectNote(store, 'Mesa', { name: 'Sales X' });
  const project = loadValidProjects(await store.loadProjects())[0]!;
  await updateProjectNote(store, project, {
    agents: [coder],
    costLimitUsd,
  });
  return { store, service, runtime, coder, projectId: project.id };
}

describe('project cost', () => {
  it('counts a direct chat in the shared spend, the same figure the board shows', async () => {
    const { store, service, coder, projectId } = await setup();
    await service.send(coder, 'first', projectId);
    const tasks = (await store.loadTasks()).map(taskFacts);
    const chats = (await store.loadChats()).map(chatFacts);
    expect(projectSpendUsd(projectId, tasks, chats, 0)).toBeCloseTo(0.6);
  });

  it('refuses a new direct project chat once the cost limit is reached', async () => {
    const { service, runtime, coder, projectId } = await setup(0.5);
    await service.send(coder, 'first', projectId);
    await expect(service.send(coder, 'second', projectId)).rejects.toThrow(
      'Project cost limit reached',
    );
    expect(runtime.requests).toHaveLength(1);
  });

  it('keeps allowing chats in a project with no cost limit, and chats without a project', async () => {
    const { service, runtime, coder, projectId } = await setup();
    await service.send(coder, 'first', projectId);
    await service.send(coder, 'second', projectId);
    await service.send(coder, 'no project');
    expect(runtime.requests).toHaveLength(3);
  });
});

describe('project cost covers every project run', () => {
  it('refuses a delegated task that would start after the limit is reached', async () => {
    const store = new MemoryStore('Mesa');
    const lead = await store.createAgent('CEO');
    const coder = await store.createAgent('Coder');
    for (const id of [lead, coder])
      await store.patchAgent(id, { runtime: 'fake' });
    await store.setManager(coder, lead);
    let project: Project | undefined;
    const runtime = new FakeRuntime((request) => {
      if (request.prompt.includes('Plan')) {
        // The limit is set after the lead's turn has started, so only the delegated task sees it.
        void updateProjectNote(store, project!, { costLimitUsd: 0.5 });
        return paid(
          '```agenthq-delegate\n' +
            JSON.stringify({ tasks: [{ to: 'Coder', task: 'Build it' }] }) +
            '\n```',
          0,
        );
      }
      return paid(request.prompt.includes('Build it') ? 'built' : 'ok', 0.6);
    }, 0);
    const service = new ChatService({
      store,
      adapters: [runtime],
      settings: () => ({
        maxParallelRuns: 1,
        allowedFolders: ['Mesa/Work'],
      }),
      vaultBasePath: '/vault',
      managedRoot: 'Mesa',
      memoryDelayMs: 60_000,
    });
    await service.initialize();
    await createProjectNote(store, 'Mesa', { name: 'Sales X' });
    project = loadValidProjects(await store.loadProjects())[0]!;
    await updateProjectNote(store, project, { agents: [lead, coder] });
    // The coder already spent 0.6 in this project before the request starts.
    await service.send(coder, 'earlier', project.id);
    // The lead's follow-up turn is refused too, so the send itself reports the limit.
    await service
      .send(lead, 'Plan the launch', project.id)
      .catch(() => undefined);
    const tasks = await store.loadTasks();
    expect(tasks).toHaveLength(1);
    expect((tasks[0]!.frontmatter as { status: string }).status).toBe('failed');
    expect(
      runtime.requests.some((request) => request.prompt.includes('Build it')),
    ).toBe(false);
  });

  it('stops a loop with the project cost limit reason when a round is refused', async () => {
    const { store, service, runtime, coder, projectId } = await setup();
    await service.send(coder, 'first', projectId);
    const project = loadValidProjects(await store.loadProjects())[0]!;
    await updateProjectNote(store, project, { costLimitUsd: 0.5 });
    const before = runtime.requests.length;
    const result = await service.startLoop(
      coder,
      { kind: 'times', rounds: 3 },
      'Again',
      projectId,
    );
    expect(result).toMatchObject({ status: 'project-limit', rounds: 0 });
    expect(runtime.requests).toHaveLength(before);
    const activity = (await store.loadActivity())
      .map((note) => note.body)
      .join('\n');
    expect(activity).toContain('Loop stopped: project cost limit reached');
  });
});
