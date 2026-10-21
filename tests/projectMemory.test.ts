import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { MemoryStore } from '../src/core/memoryStore';
import {
  logEntries,
  memoryCostFromLog,
  parseMemoryBlocks,
  rankSnippets,
  resolveMemoryRuntime,
  taskLogEntry,
  truncateWords,
} from '../src/core/memory';
import {
  createProjectNote,
  loadValidProjects,
  updateProjectNote,
  type MemoryChoice,
} from '../src/core/projects';
import { FakeRuntime, type FakeScripts } from '../src/core/runtimes/fake';

const reply = (text: string) => [
  { type: 'done' as const, text, isError: false },
];
const delegate = (tasks: { to: string; task: string }[]) =>
  '```agenthq-delegate\n' + JSON.stringify({ tasks }) + '\n```';
const memoryBlock = (memories: object[]) =>
  '```agenthq-memory\n' + JSON.stringify({ memories }) + '\n```';

/** A project run with a delegated task. The memory delay is long, so extraction runs only when a test calls it. */
async function setup(script: FakeScripts, memoryModel?: MemoryChoice) {
  const store = new MemoryStore('Obi-I');
  const lead = await store.createAgent('CEO');
  const coder = await store.createAgent('Coder');
  for (const id of [lead, coder])
    await store.patchAgent(id, { runtime: 'fake' });
  await store.setManager(coder, lead);
  const runtime = new FakeRuntime(script, 0);
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 1, allowedFolders: ['Obi-I/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Obi-I',
    memoryDelayMs: 60_000,
  });
  await service.initialize();
  await createProjectNote(store, 'Obi-I', {
    name: 'Sales X',
    instructions: 'Sell the product.',
  });
  const [note] = await store.loadProjects();
  const project = loadValidProjects([note!])[0]!;
  await updateProjectNote(store, project, {
    agents: [lead, coder],
    memoryModel,
  });
  const saved = loadValidProjects(await store.loadProjects())[0]!;
  return { store, service, runtime, lead, coder, project: saved };
}

const planScript = (request: { prompt: string }) =>
  request.prompt.includes('Plan')
    ? reply(delegate([{ to: 'Coder', task: 'Build it' }]))
    : request.prompt.includes('Results from')
      ? reply('All done')
      : reply('Built');

describe('project memory: the log', () => {
  it('writes one log entry per finished task without any model call', async () => {
    const { service, store, runtime, lead, project } = await setup(planScript);
    await service.send(lead, 'Plan the launch', project.id);
    const log = await store.loadNote('Obi-I/Projects/Sales X/Log.md');
    expect(logEntries(log)).toHaveLength(1);
    expect(log?.body).toContain('Coder');
    expect(
      runtime.requests.some((request) =>
        request.prompt.startsWith('Memory extraction'),
      ),
    ).toBe(false);
    expect(runtime.requests).toHaveLength(3);
  });

  it('formats an entry with agent, status, verdict and task link', () => {
    expect(
      taskLogEntry({
        time: '2026-10-18T10:00:00.000Z',
        link: '[[Build it]]',
        agent: 'Coder',
        status: 'passed',
        verdict: 'pass',
      }),
    ).toBe(
      '- 2026-10-18T10:00:00.000Z · [[Build it]] · Coder · passed · verdict: pass',
    );
  });
});

describe('project memory: extraction', () => {
  it('extracts memory notes with a non-Claude runtime, then merges into them', async () => {
    let round = 0;
    const { service, store, lead, project } = await setup((request) => {
      if (request.prompt.startsWith('Memory extraction')) {
        round++;
        return reply(
          memoryBlock([
            round === 1
              ? {
                  type: 'fact',
                  title: 'Launch date',
                  body: 'The launch is on 1 May.',
                  tags: ['launch'],
                }
              : {
                  type: 'fact',
                  title: 'Launch date',
                  body: 'The launch moved to 2 May.',
                },
          ]),
        );
      }
      return planScript(request);
    });
    await service.send(lead, 'Plan the launch', project.id);
    await service.extractMemory(project.id);
    const first = await store.loadNotesUnder('Obi-I/Projects/Sales X/Memory');
    expect(first.map((note) => note.name)).toEqual(['Launch date']);
    expect(first[0]!.frontmatter).toMatchObject({
      agenthq: 'memory',
      type: 'fact',
      tags: ['launch'],
    });

    await service.send(lead, 'Plan the launch again', project.id);
    await service.extractMemory(project.id);
    const merged = await store.loadNotesUnder('Obi-I/Projects/Sales X/Memory');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.body).toContain('The launch is on 1 May.');
    expect(merged[0]!.body).toContain('The launch moved to 2 May.');
    const log = await store.loadNote('Obi-I/Projects/Sales X/Log.md');
    expect(log?.body).toContain('memory: 1 saved, 0 merged');
    expect(log?.body).toContain('memory: 0 saved, 1 merged');
  });

  it('does nothing when the memory model is off, and says so only in the log', async () => {
    const { service, store, runtime, lead, project } = await setup(
      planScript,
      'off',
    );
    await service.send(lead, 'Plan the launch', project.id);
    await service.extractMemory(project.id);
    expect(
      runtime.requests.some((request) =>
        request.prompt.startsWith('Memory extraction'),
      ),
    ).toBe(false);
    expect(await store.loadNotesUnder('Obi-I/Projects/Sales X/Memory')).toEqual(
      [],
    );
  });

  it('skips extraction once the project cost limit is reached', async () => {
    const { service, store, runtime, lead, project } = await setup(planScript);
    await service.send(lead, 'Plan the launch', project.id);
    await updateProjectNote(store, project, { costLimitUsd: 0 });
    await service.extractMemory(project.id);
    expect(
      runtime.requests.some((request) =>
        request.prompt.startsWith('Memory extraction'),
      ),
    ).toBe(false);
    const log = await store.loadNote('Obi-I/Projects/Sales X/Log.md');
    expect(log?.body).toContain('memory skipped: project cost limit reached');
  });
});

describe('project memory: agent blocks and retrieval', () => {
  it('saves a decision to the log and a fact as a memory note, from an agent reply', async () => {
    const { service, store, coder, project } = await setup(() =>
      reply(
        'Noted.\n' +
          memoryBlock([
            {
              type: 'decision',
              title: 'Use Lisbon office',
              body: 'We ship from Lisbon.',
            },
            {
              type: 'fact',
              title: 'Warehouse',
              body: 'The warehouse is in Setubal.',
            },
          ]),
      ),
    );
    await service.send(coder, 'hi', project.id);
    const log = await store.loadNote('Obi-I/Projects/Sales X/Log.md');
    expect(log?.body).toContain('decision: Use Lisbon office');
    const notes = await store.loadNotesUnder('Obi-I/Projects/Sales X/Memory');
    expect(notes.map((note) => note.name)).toEqual(['Warehouse']);
  });

  it('logs a refused memory block and saves nothing from it', async () => {
    const { service, store, coder, project } = await setup(() =>
      reply(
        '```agenthq-memory\n{"memories":[{"type":"secret","title":"x","body":"y"}]}\n```',
      ),
    );
    await service.send(coder, 'hi', project.id);
    const log = await store.loadNote('Obi-I/Projects/Sales X/Log.md');
    expect(log?.body).toContain('A memory block was refused');
    expect(await store.loadNotesUnder('Obi-I/Projects/Sales X/Memory')).toEqual(
      [],
    );
  });

  it('injects the relevant memory into the next run, and not into runs of other agents', async () => {
    const { service, store, runtime, coder, lead, project } = await setup(() =>
      reply('ok'),
    );
    await store.createFolder('Obi-I/Projects/Sales X/Memory');
    await store.createNote(
      'Obi-I/Projects/Sales X/Memory/Warehouse.md',
      { agenthq: 'memory', type: 'fact' },
      'The warehouse is in Setubal.',
    );
    await service.send(coder, 'Where is the warehouse?', project.id);
    expect(runtime.requests[0]!.systemPrompt).toContain(
      'Relevant project memory',
    );
    expect(runtime.requests[0]!.systemPrompt).toContain('Setubal');
    await service.send(lead, 'Hello there', project.id);
    expect(runtime.requests[1]!.systemPrompt).not.toContain(
      'Relevant project memory',
    );
  });
});

describe('project memory: pure helpers', () => {
  it('ranks the best match first and respects the word cap', () => {
    const docs = [
      { id: 'a', text: 'The warehouse is in Setubal near the river.' },
      { id: 'b', text: 'Pricing discussion about the annual plan.' },
      { id: 'c', text: 'Warehouse warehouse warehouse staffing rota.' },
    ];
    expect(rankSnippets('warehouse', docs, 1500).map((doc) => doc.id)).toEqual([
      'c',
      'a',
    ]);
    expect(rankSnippets('warehouse', docs, 8).map((doc) => doc.id)).toEqual([
      'c',
    ]);
    expect(rankSnippets('nothing matches here', docs, 1500)).toEqual([]);
  });

  it('caps long text to the given number of words', () => {
    expect(truncateWords('one two three four', 2)).toBe('one two …');
    expect(truncateWords('one two', 5)).toBe('one two');
  });

  it('reads agent memory blocks and reports invalid ones', () => {
    const text =
      memoryBlock([{ type: 'fact', title: 'A', body: 'B' }]) +
      '\n```agenthq-memory\nnot json\n```';
    const { items, problems } = parseMemoryBlocks(text);
    expect(items.map((item) => item.title)).toEqual(['A']);
    expect(problems).toHaveLength(1);
  });

  it('counts the memory cost recorded in the log', () => {
    expect(
      memoryCostFromLog([
        '- x · memory cost $0.0120',
        '- y · memory cost $0.0030',
      ]),
    ).toBeCloseTo(0.015);
  });

  it('picks the cheapest runtime for auto, honours off, and falls back to any available runtime', () => {
    const claude = { id: 'claude-code', displayName: 'Claude Code' } as never;
    const fake = { id: 'fake', displayName: 'Fake' } as never;
    expect(resolveMemoryRuntime('off', [claude], () => true)).toBeNull();
    expect(
      resolveMemoryRuntime('auto', [fake, claude], () => true),
    ).toMatchObject({
      adapter: claude,
      model: 'haiku',
    });
    expect(resolveMemoryRuntime('auto', [fake], () => true)).toMatchObject({
      adapter: fake,
      model: '',
    });
    expect(resolveMemoryRuntime('auto', [fake], () => false)).toBeNull();
  });
});
