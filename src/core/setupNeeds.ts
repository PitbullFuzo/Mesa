/**
 * What an agent will need switched on in Setup, guessed from its job. Obi lists these on a proposal card but never
 * turns them on itself: they stay the owner's choice. Each line names the exact place to click.
 */
const NEEDS: { test: RegExp; line: (name: string) => string }[] = [
  {
    test: /\b(?:writ(?:e|er|ing)|edit(?:or|ing)?|draft(?:ing)?|author|note[- ]?tak|wiki|journal|documentation|content|copy)\b/i,
    line: (name) =>
      `Permission: Edit, and tick the note destinations it writes to (Open ${name} → Setup → Permission, then Note destinations)`,
  },
  {
    test: /\b(?:seo|research(?:er)?|news|analyst|market|competitor|web|fact[- ]?check|trend|scout)\b/i,
    line: (name) => `Web access (Open ${name} → Setup → Web access)`,
  },
  {
    test: /\b(?:summar(?:y|ise|ize)|organi[sz]er|librarian|vault|knowledge|curator|archivist|search(?:er)? (?:the )?notes?)\b/i,
    line: (name) => `Vault access: Read (Open ${name} → Setup → Vault access)`,
  },
  {
    test: /\b(?:brows(?:e|er|ing)|scrape|scraper|web ?site tester|click through|crawl)\b/i,
    line: (name) =>
      `Browser control (Open ${name} → Setup → Browser control; needs Node.js)`,
  },
  {
    test: /\b(?:run(?:ner)? commands?|script(?:s|ing)?|devops|build(?:er)?|developer|programmer|coder|install|terminal|shell)\b/i,
    line: (name) =>
      `Run commands (Open ${name} → Setup → Run commands; Off by default)`,
  },
  {
    test: /\b(?:e-?mail|inbox|outlook|calendar|schedul(?:e|er|ing) meetings?|onedrive|assistant to the owner|secretary)\b/i,
    line: (name) =>
      `Microsoft 365 connector (Settings → Connectors, then Open ${name} → Setup → Can use Microsoft 365)`,
  },
];

/** The Setup switches an agent with this name, role and instructions will probably need. */
export function setupNeeds(
  name: string,
  role = '',
  instructions = '',
): string[] {
  const job = `${name} ${role} ${instructions}`;
  return NEEDS.filter((need) => need.test.test(job)).map((need) =>
    need.line(name),
  );
}

/** The guide's table, one row per job, so Obi and the owner read the same thing. */
export const WHAT_EACH_AGENT_NEEDS = [
  '| If the agent will… | Turn on, in its Setup |',
  '| --- | --- |',
  '| Write or edit notes | Permission: Edit, and tick the Note destinations it writes to |',
  '| Do SEO, research or news | Web access |',
  '| Read your vault | Vault access: Read |',
  '| Browse websites | Browser control |',
  '| Run commands or scripts | Run commands |',
  '| Use email or calendar | The Microsoft 365 connector (Settings → Connectors), then Can use Microsoft 365 |',
].join('\n');
