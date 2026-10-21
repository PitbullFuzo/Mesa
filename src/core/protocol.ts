import { z } from 'zod';

export const delegationSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            to: z.string().trim().min(1),
            task: z.string().trim().min(1),
            verifyWith: z.string().trim().min(1).optional(),
            maxAttempts: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type DelegatedTask = z.infer<typeof delegationSchema>['tasks'][number];
const verdictSchema = z
  .object({ verdict: z.enum(['pass', 'fail']), feedback: z.string() })
  .strict();
export function parseVerdict(text: string): {
  verdict: 'pass' | 'fail';
  feedback: string;
} {
  const markers = text.match(/^\s*```agenthq-verdict\b/gm);
  const match =
    /^```agenthq-verdict[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/.exec(
      text.slice(text.indexOf('```agenthq-verdict')),
    );
  if (markers?.length === 1 && match) {
    try {
      const result = verdictSchema.safeParse(JSON.parse(match[1]!));
      if (result.success) return result.data;
    } catch {
      /* Invalid JSON fails closed. */
    }
  }
  return { verdict: 'fail', feedback: 'No valid verdict given' };
}
export type DelegationResult =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; tasks: DelegatedTask[] };

export function parseDelegation(text: string): DelegationResult {
  const markers = text.match(/^\s*```agenthq-delegate\b/gm);
  if (!markers) return { kind: 'none' };
  const match =
    /^```agenthq-delegate[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/.exec(
      text.slice(text.indexOf('```agenthq-delegate')),
    );
  if (markers.length !== 1 || !match)
    return {
      kind: 'invalid',
      reason:
        'End your reply with exactly one complete agenthq-delegate block.',
    };
  try {
    const result = delegationSchema.safeParse(JSON.parse(match[1]!));
    return result.success
      ? { kind: 'valid', tasks: result.data.tasks }
      : { kind: 'invalid', reason: result.error.message };
  } catch {
    return {
      kind: 'invalid',
      reason: 'Delegation block must contain valid JSON.',
    };
  }
}
