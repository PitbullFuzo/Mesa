export type BroadcastTarget =
  | { kind: 'everyone' }
  | { kind: 'group'; id: string }
  | { kind: 'agent'; id: string };

export interface BroadcastRecipient {
  key: string;
  agentId?: string;
  name: string;
  status: 'sending' | 'replied' | 'skipped' | 'error' | 'cancelled';
  reason?: string;
}

export interface BroadcastSnapshot {
  target: BroadcastTarget;
  text: string;
  running: boolean;
  recipients: BroadcastRecipient[];
}
