import type { ChatEntry, ChatStatus } from './chat';
import {
  runLoop,
  type LoopResult,
  type LoopSpec,
  type LoopTurn,
} from './loops';

/** What a running loop remembers: whether it was stopped, who judges it, and which round it is on. */
export interface LoopEntry {
  stopped: boolean;
  verifierId?: string;
  progress: { round: number; rounds: number };
}

/** The parts of the chat service a loop needs. */
export interface LoopHost {
  /** Sends one chat turn and waits for it to end. */
  send(agentId: string, prompt: string): Promise<unknown>;
  messages(agentId: string): ChatEntry[];
  status(agentId: string): ChatStatus | undefined;
  /** Set when the loop runs for a project: a truthy answer means the project's cost limit refuses the round. */
  limitRefusal?: () => Promise<unknown>;
  publish(): void;
}

/** Runs the rounds of a loop (and its reviewer's verdicts) as ordinary chat turns. */
export async function runLoopRounds(
  host: LoopHost,
  entry: LoopEntry,
  agentId: string,
  spec: LoopSpec,
  message: string,
): Promise<LoopResult> {
  // One turn of a chat: the reply it produced, or null when the loop was stopped or the turn did not finish.
  const turnOf = async (
    id: string,
    prompt: string,
  ): Promise<LoopTurn | null> => {
    // A round the project cost limit refuses is reported as such, not as an error.
    if (host.limitRefusal) {
      const refusal = await host.limitRefusal();
      if (refusal) return { text: '', costUsd: 0, failed: false, limit: true };
    }
    const before = host.messages(id).length;
    try {
      await host.send(id, prompt);
    } catch {
      return { text: '', costUsd: 0, failed: true };
    }
    const messages = host.messages(id);
    const reply = [...messages].reverse().find((m) => m.role === 'assistant');
    if (entry.stopped || messages.length <= before || !reply || reply.cancelled)
      return null;
    const status = host.status(id);
    return {
      text: reply.content,
      costUsd: reply.costUsd ?? 0,
      failed:
        status === 'error' || status === 'offline' || status === 'needs-you',
    };
  };
  return runLoop(spec, message, {
    run: (prompt) => turnOf(agentId, prompt),
    judge: (prompt) =>
      entry.verifierId
        ? turnOf(entry.verifierId, prompt)
        : Promise.resolve(null),
    progress: (round, rounds) => {
      entry.progress = { round, rounds };
      host.publish();
    },
    stopped: () => entry.stopped,
  });
}
