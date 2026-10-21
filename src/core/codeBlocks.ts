/** A code block longer than this is collapsed in the chat. Shorter blocks stay expanded. */
export const COLLAPSE_AFTER_LINES = 10;

/** The number of lines in a block's text; a trailing newline does not add a line. */
export function codeLineCount(text: string): number {
  const trimmed = text.replace(/\n$/, '');
  return trimmed === '' ? 0 : trimmed.split('\n').length;
}

/** The language from a rendered block's classes (`language-ts` gives `ts`); null when there is none. */
export function languageOf(classes: string[]): string | null {
  const found = classes.find((name) => name.startsWith('language-'));
  const language = found?.slice('language-'.length) ?? '';
  return language === '' ? null : language;
}

export interface CodeBlockSummary {
  language: string;
  lines: number;
  collapsible: boolean;
  /** "Code · ts · 12 lines", with a leading ▸ when collapsed. */
  header: (collapsed: boolean) => string;
}

export function codeBlockSummary(
  text: string,
  language: string | null,
): CodeBlockSummary {
  const lines = codeLineCount(text);
  const shown = language ?? 'text';
  return {
    language: shown,
    lines,
    collapsible: lines > COLLAPSE_AFTER_LINES,
    header: (collapsed) =>
      `${collapsed ? '▸ ' : ''}Code · ${shown} · ${lines} line${lines === 1 ? '' : 's'}`,
  };
}
