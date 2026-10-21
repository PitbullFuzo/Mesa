/**
 * Runtimes report a blocked read or write in their own words (flags, sandbox modes). The owner only needs to know
 * what to click in Mesa, so the plugin maps the common messages to one short Mesa-worded hint.
 */
const BLOCKED_PATTERNS: { test: RegExp; hint: string }[] = [
  {
    test: /read[- ]only|permission (?:is )?(?:set to )?(?:read|plan)|plan mode|edit (?:was )?(?:denied|not permitted)|write (?:was )?(?:denied|blocked)/i,
    hint: 'This agent is set to read only. Open the agent → Setup → Permission and choose Edit, then ask again.',
  },
  {
    test: /outside (?:of )?(?:the )?(?:allowed|working|project|workspace)|not in (?:the )?allowed|add-dir|additional director|allowed (?:working )?director|path is not (?:allowed|permitted)|not permitted to (?:read|write|access)/i,
    hint: 'That folder is not turned on for this agent. Open the agent → Setup → Note destinations (or Outside folders) and tick the folder, then ask again.',
  },
  {
    test: /sandbox|restricted|operation not permitted|access is denied|permission denied|EACCES|EPERM/i,
    hint: 'Mesa blocked that file or folder for this agent. Open the agent → Setup, check Permission and the ticked folders, then ask again.',
  },
];

/** A short Mesa-worded hint for a blocked read/write message, or undefined when it is not one. */
export function blockedHint(text: string): string | undefined {
  return BLOCKED_PATTERNS.find((entry) => entry.test.test(text))?.hint;
}
