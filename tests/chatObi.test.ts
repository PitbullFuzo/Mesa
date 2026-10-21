import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/core/chat';
import { ensureObi, OBI_ID } from '../src/core/obi';
import { MemoryStore } from '../src/core/memoryStore';
import type {
  RunEvent,
  RunRequest,
  RuntimeAdapter,
} from '../src/core/runtimes/types';

class ControlledRuntime implements RuntimeAdapter {
  id = 'fake' as const;
  displayName = 'Test runtime';
  requests: RunRequest[] = [];
  callbacks: ((event: RunEvent) => void)[] = [];
  async detect() {
    return { available: true };
  }
  start(request: RunRequest, callback: (event: RunEvent) => void) {
    this.requests.push(request);
    this.callbacks.push(callback);
    return { stop: async () => {} };
  }
  finish(text: string) {
    const callback = this.callbacks.at(-1)!;
    callback({ type: 'session', sessionId: this.requests.at(-1)!.sessionId });
    callback({ type: 'done', text, isError: false });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const store = new MemoryStore();
  await ensureObi(store, store.root);
  await store.patchAgent(OBI_ID, { runtime: 'fake' });
  const runtime = new ControlledRuntime();
  const service = new ChatService({
    store,
    adapters: [runtime],
    settings: () => ({ maxParallelRuns: 2, allowedFolders: ['Mesa/Work'] }),
    vaultBasePath: '/vault',
    managedRoot: 'Mesa',
    agentLink: async () => '[[Obi]]',
  });
  await service.initialize();
  return { store, service, runtime };
}

async function say(
  service: ChatService,
  runtime: ControlledRuntime,
  text: string,
  reply: string,
) {
  const sent = service.send(OBI_ID, text);
  await tick();
  runtime.finish(reply);
  await sent;
}

const withBlock = (json: string) =>
  `Proposal ready.\n\`\`\`agenthq-admin\n${json}\n\`\`\``;

describe('Obi chat', () => {
  it('turns its admin block into one proposal per action, with the team snapshot in its prompt', async () => {
    const { service, runtime } = await setup();
    await say(
      service,
      runtime,
      'Create a group called Research',
      withBlock(
        '{"actions":[{"type":"createGroup","name":"Research","color":"#2563eb"},{"type":"createAgent","name":"Researcher","group":"Research","reportsTo":"CEO"}]}',
      ),
    );
    const proposals = service.getSnapshot().agents[OBI_ID]!.proposals!;
    expect(proposals).toHaveLength(2);
    expect(runtime.requests[0]!.systemPrompt).toContain('## Team snapshot');
    expect(runtime.requests[0]!.systemPrompt).toContain('## Team changes');
  });

  it('removes a proposal once it is resolved', async () => {
    const { service, runtime } = await setup();
    await say(
      service,
      runtime,
      'Make a group',
      withBlock(
        '{"actions":[{"type":"createGroup","name":"A","color":"#000000"},{"type":"createGroup","name":"B","color":"#111111"}]}',
      ),
    );
    const [first, second] = service.getSnapshot().agents[OBI_ID]!.proposals!;
    service.resolveProposal(OBI_ID, first!.id);
    expect(
      service.getSnapshot().agents[OBI_ID]!.proposals!.map((p) => p.id),
    ).toEqual([second!.id]);
  });

  it('reports invalid proposals back to Obi on its next turn', async () => {
    const { service, runtime } = await setup();
    await say(
      service,
      runtime,
      'Delete the CEO',
      withBlock('{"actions":[{"type":"deleteAgent","id":"ceo"}]}'),
    );
    expect(service.getSnapshot().agents[OBI_ID]!.proposals).toEqual([]);
    await say(service, runtime, 'Try again', 'Sorry, here is a plain answer.');
    const next = runtime.requests.at(-1)!;
    expect(next.prompt).toContain('Notes from Mesa about your last proposal');
    expect(next.prompt).toContain('not valid');
    expect(next.prompt).toContain('Try again');
  });

  it('gives the team snapshot only to Obi, not to other agents', async () => {
    const { store, service, runtime } = await setup();
    const coder = await store.createAgent('Coder');
    await store.patchAgent(coder, { runtime: 'fake' });
    await service.refreshAgents();
    const sent = service.send(coder, 'hello');
    await tick();
    runtime.finish('hi');
    await sent;
    expect(runtime.requests.at(-1)!.systemPrompt).not.toContain(
      '## Team snapshot',
    );
  });
});
