import { describe, expect, it } from 'vitest';
import {
  codeBlockSummary,
  codeLineCount,
  COLLAPSE_AFTER_LINES,
  languageOf,
} from '../src/core/codeBlocks';

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('code blocks in chat', () => {
  it('counts lines, ignoring one trailing newline', () => {
    expect(codeLineCount('a\nb\nc')).toBe(3);
    expect(codeLineCount('a\nb\n')).toBe(2);
    expect(codeLineCount('')).toBe(0);
  });

  it('collapses only blocks longer than 10 lines', () => {
    expect(COLLAPSE_AFTER_LINES).toBe(10);
    expect(codeBlockSummary(lines(10), 'ts').collapsible).toBe(false);
    expect(codeBlockSummary(lines(11), 'ts').collapsible).toBe(true);
  });

  it('reads the language from the rendered classes, or uses text', () => {
    expect(languageOf(['el-pre', 'language-ts'])).toBe('ts');
    expect(languageOf(['language-'])).toBeNull();
    expect(languageOf(['plain'])).toBeNull();
    expect(codeBlockSummary('x', null).language).toBe('text');
  });

  it('shows the header as "▸ Code · language · N lines" when collapsed', () => {
    const summary = codeBlockSummary(lines(12), 'python');
    expect(summary.header(true)).toBe('▸ Code · python · 12 lines');
    expect(summary.header(false)).toBe('Code · python · 12 lines');
  });

  it('uses the singular for one line', () => {
    expect(codeBlockSummary('x', 'sh').header(false)).toBe(
      'Code · sh · 1 line',
    );
  });
});
