import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  createProjectNote,
  parseProject,
  updateProjectNote,
  type Project,
} from '../src/core/projects';
import { FakeRuntime, type FakeScripts } from '../src/core/runtimes/fake';

const reply = (text: string) => [
  { type: 'done' as const, text, isError: false },
];
const delegate = (tasks: { to: string; task: string }[]) =>
  '```agenthq-delegate\n' + JSON.stringify({ tasks }) + '\n```';

async function setup(script: FakeScripts) {
  const store = new MemoryStore('Obi-I');
  const lead = await store.createAgent('CEO');
  const coder = await store.createAgent('Coder');
  const scribe = await store.createAgent('Scribe');
  for (const id of [lead, coder, scribe])
    await store.patchAgent(id, { runtime: 'fake' });
  await store.setManager(coder, lead);
  const runtime = new FakeRuntime(script, 0);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
  });
  await service.initialize();
  await createProjectNote(store, 'Obi-I', {
    name: 'Sales X',
    instructions: 'Sell the product.',
  });
  const [note] = await store.loadProjects();
  const project = parseProject(note!) as Project;
  await updateProjectNote(store, project, { agents: [lead, coder] });
  return {
    store,
    service,
    runtime,
    lead,
    coder,
    scribe,
    projectId: project.id,
  };
}

describe('project runs', () => {
  it('adds the project section only for an assigned agent in that project', async () => {
    const { service, runtime, coder, scribe, projectId } = await setup(() =>
      reply('ok'),
    );
    await service.send(coder, 'hi', projectId);
    await service.send(scribe, 'hi', projectId);
    expect(runtime.requests[0]!.systemPrompt).toContain('Sell the product.');
    expect(runtime.requests[1]!.systemPrompt).not.toContain(
      'Sell the product.',
    );
  });

  it('records the project on the chat note', async () => {
    const { service, store, coder, projectId } = await setup(() => reply('ok'));
    await service.send(coder, 'hi', projectId);
    const chat = (await store.loadChats()).find(
      (note) => (note.frontmatter as { agentId?: string }).agentId === coder,
    );
    expect(chat?.frontmatter).toMatchObject({ projectId });
  });

  it('delegated tasks inherit the project, and the worker runs with its section', async () => {
    const { service, store, runtime, lead, coder, projectId } = await setup(
      (request) =>
        request.prompt.includes('Plan')
          ? reply(delegate([{ to: 'Coder', task: 'Build it' }]))
          : request.prompt.includes('Results from')
            ? reply('All done')
            : reply('Built'),
    );
    await service.send(lead, 'Plan the launch', projectId);
    const tasks = await store.loadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.frontmatter).toMatchObject({ projectId, toId: coder });
    const worker = runtime.requests.find((request) =>
      request.prompt.includes('Build it'),
    );
    expect(worker?.systemPrompt).toContain('Sell the product.');
  });

  it('runs without a project carry no project section', async () => {
    const { service, runtime, coder } = await setup(() => reply('ok'));
    await service.send(coder, 'hi');
    expect(runtime.requests[0]!.systemPrompt).not.toContain(
      'Sell the product.',
    );
  });
});
