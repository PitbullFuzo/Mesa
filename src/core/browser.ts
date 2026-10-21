export type BrowserEngine = 'playwright' | 'hermes';
export interface BrowserStatus {
  engine: BrowserEngine;
  available: boolean;
  hint: string;
}
export const BROWSER_WARNING =
  'Browser control can submit forms, send information and change websites. Pages may contain malicious instructions. It uses a fresh isolated profile without your saved logins or cookies. Only enable it for trusted agents.';
/** Shown instead of the usual warning when a Codex agent (which can read the whole computer) gets the browser. */
export const BROWSER_CODEX_WARNING =
  'This agent can read files anywhere on this computer and use a browser: a bad web page could trick it into sending your files out.';
/** Runtimes that can load exactly Obi-I's browser server for one run (see DECISIONS.md, Step 28c research). */
const BROWSER_RUNTIMES = ['claude-code', 'opencode', 'hermes', 'codex'];
export function browserUnavailableReason(
  runtime: string,
  wholeComputerReadConfirmed: boolean,
  engine: BrowserEngine,
  browserReadsConfirmed = false,
): string {
  if (
    wholeComputerReadConfirmed &&
    !(runtime === 'codex' && browserReadsConfirmed)
  )
    return runtime === 'codex'
      ? 'Codex can read the whole computer. Tick “Allow the browser together with whole-computer reads” to give it the browser.'
      : 'Browser control is refused for agents with whole-computer reads.';
  if (engine === 'hermes')
    return 'Hermes browser is unavailable: isolated profile, confined browser_exec code and Stop cleanup are not verified for the installed backend. Real-profile browsing is never used.';
  if (!BROWSER_RUNTIMES.includes(runtime))
    return 'This runtime cannot load exactly Obi-I’s isolated browser, so browser control is refused.';
  return '';
}
