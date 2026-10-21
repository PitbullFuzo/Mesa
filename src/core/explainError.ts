import { blockedHint } from './blockedHints';

export interface ErrorExplanation {
  happened: string;
  why: string;
  todo: string;
  /** The runtime's own words, kept for people who want them. Empty when there is nothing to add. */
  technical: string;
}

interface Rule {
  test: RegExp;
  happened: string;
  why: string;
  todo: (who: string) => string;
}

const RULES: Rule[] = [
  {
    test: /read[- ]only|plan mode|permission (?:is )?(?:set to )?read|edit (?:was )?(?:denied|not permitted)|write (?:was )?(?:denied|blocked)/i,
    happened: 'The agent could not change a file.',
    why: 'Its Permission is set to read only.',
    todo: (who) =>
      `Open ${who} → Setup → Permission and choose Edit, then try again.`,
  },
  {
    test: /outside (?:of )?(?:the )?(?:allowed|working|project|workspace)|not in (?:the )?allowed|add-dir|additional director|allowed (?:working )?director|path is not (?:allowed|permitted)|not permitted to (?:read|write|access)/i,
    happened: 'The agent could not use a folder.',
    why: 'That folder is not turned on for this agent.',
    todo: (who) =>
      `Open ${who} → Setup → Note destinations (or Outside folders), tick the folder, then try again.`,
  },
  {
    test: /web access (?:is )?(?:off|disabled)|web ?(?:fetch|search) (?:is )?(?:not allowed|disabled|blocked)|internet access (?:is )?(?:off|disabled)/i,
    happened: 'The agent could not open a web page.',
    why: 'Web access is off for this agent.',
    todo: (who) =>
      `Open ${who} → Setup → Web access and turn it on, then try again.`,
  },
  {
    test: /microsoft|graph\.microsoft|m365|invalid_grant|AADSTS|token (?:has )?expired/i,
    happened: 'Mesa could not reach your Microsoft 365 account.',
    why: 'The sign-in has expired or was removed.',
    todo: () =>
      'Open Settings → Connectors → Microsoft 365 and press Sign in again.',
  },
  {
    test: /browser (?:is )?not (?:set up|installed|available)|playwright|chrome.*not found/i,
    happened: 'The agent could not use the browser.',
    why: 'Browser control is not set up on this computer, or is off for this agent.',
    todo: (who) =>
      `Open ${who} → Setup → Browser control and turn it on. Browser control also needs Node.js from nodejs.org.`,
  },
  {
    test: /command line is too long|argument list too long|e2big|enametoolong/i,
    happened: 'The message was too long for the AI tool to receive.',
    why: 'Windows limits how long a command can be.',
    todo: () =>
      'Send a shorter message or fewer attachments, or start a new chat.',
  },
  {
    test: /not found|enoent|command not found|not installed|is not recognized|unavailable/i,
    happened: 'Mesa could not start the AI tool for this agent.',
    why: 'The tool is not installed, or Mesa cannot find it.',
    todo: (who) =>
      `Install it (see the Guide, “What you need”) or open ${who} → Setup and pick a tool you have installed.`,
  },
  {
    test: /not (?:logged|signed) in|login|log in|sign in|unauthori[sz]ed|\b401\b|authentication|api key/i,
    happened: 'The AI tool did not accept your sign-in.',
    why: 'You are not signed in, or the sign-in has expired.',
    todo: () =>
      'Open a terminal, run that AI tool once and sign in, then try again.',
  },
  {
    test: /rate limit|\b429\b|quota|credit|billing|insufficient|overloaded|usage limit|too many requests/i,
    happened: 'The AI provider turned the request down.',
    why: 'You hit a usage limit, ran out of credit, or the provider is busy.',
    todo: () =>
      'Wait a few minutes, or check your plan and credit with your AI provider, then try again. A cheaper model also helps.',
  },
  {
    test: /model.*(?:not found|does not exist|unknown|invalid)|invalid model|unknown model/i,
    happened: 'The chosen AI model is not available.',
    why: 'The model name is wrong, or your plan does not include it.',
    todo: (who) => `Open ${who} → Setup → Model and pick another one.`,
  },
  {
    test: /timed? ?out|timeout|etimedout/i,
    happened: 'The agent took too long and was stopped.',
    why: 'The task was big, or the AI provider was slow.',
    todo: () => 'Try again, or ask for a smaller piece of work.',
  },
  {
    test: /sandbox|restricted|operation not permitted|access is denied|permission denied|eacces|eperm/i,
    happened: 'Mesa blocked a file or folder for this agent.',
    why: 'The agent is not allowed to use it.',
    todo: (who) =>
      `Open ${who} → Setup, check Permission and the ticked folders, then try again.`,
  },
];

const FENCE = '`'.repeat(3);

/** Turns any runtime, tool or connector error into three plain parts, keeping the original text as technical details. */
export function explainError(raw: string, who = 'the agent'): ErrorExplanation {
  const text = raw.trim();
  const rule = RULES.find((entry) => entry.test.test(text));
  if (rule)
    return {
      happened: rule.happened,
      why: rule.why,
      todo: rule.todo(who),
      technical: text,
    };
  return {
    happened: 'Something went wrong while the agent was working.',
    why: 'Mesa does not recognise this error.',
    todo:
      blockedHint(text) ??
      'Try again. If it keeps happening, ask Obi, or open the technical details below.',
    technical: text,
  };
}

/** The explanation as Markdown for a chat bubble or task note; the technical text sits in a closed box. */
export function formatExplanation(explanation: ErrorExplanation): string {
  const lines = [
    `**What happened:** ${explanation.happened}`,
    `**Why:** ${explanation.why}`,
    `**What to do:** ${explanation.todo}`,
  ];
  if (explanation.technical)
    lines.push(
      `<details><summary>Technical details</summary>\n\n${FENCE}\n${explanation.technical.split(FENCE).join("'''")}\n${FENCE}\n\n</details>`,
    );
  return lines.join('\n\n');
}

/** One short line without Markdown, for the Inbox. */
export function explanationLine(explanation: ErrorExplanation): string {
  return `${explanation.happened} ${explanation.why} ${explanation.todo}`;
}
