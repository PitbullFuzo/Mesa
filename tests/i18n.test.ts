import { afterEach, describe, expect, it } from 'vitest';
import {
  DICTIONARY_FOR_TESTS,
  resolveLanguage,
  setLanguage,
  t,
  type TextKey,
} from '../src/core/i18n';
import { elapsed, liveSummary, statusLabel } from '../src/core/liveActivity';
import { formatSpend } from '../src/core/costs';
import { loadSettings } from '../src/core/settings';

const { en, pt } = DICTIONARY_FOR_TESTS;
const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

afterEach(() => setLanguage('en'));

describe('translations', () => {
  it('has a Portuguese text for every English key, and no extra ones', () => {
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as TextKey[]) {
      expect(pt[key].trim(), key).not.toBe('');
      expect(placeholders(pt[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('keeps the English text exactly as it was written', () => {
    expect(t('page.activity')).toBe('Live activity');
    expect(t('live.queue', { running: 2, queued: 3 })).toBe(
      ' (2 running, 3 in the queue)',
    );
    expect(statusLabel('needs-you')).toBe('Needs you');
    expect(
      elapsed('2026-11-05T10:00:00.000Z', new Date('2026-11-05T11:05:00.000Z')),
    ).toBe('for 1 h 5 min');
    expect(formatSpend({ usd: 0, tokens: 2000 })).toBe('2,000 tokens');
  });

  it('speaks European Portuguese when asked', () => {
    setLanguage('pt');
    expect(t('page.activity')).toBe('Atividade em direto');
    expect(statusLabel('working')).toBe('A trabalhar');
    expect(
      liveSummary([
        { id: 'a', name: 'A', status: 'working', steps: 0 },
        { id: 'b', name: 'B', status: 'needs-you', steps: 0 },
      ]),
    ).toBe('1 a trabalhar · 1 precisa de si');
    // Brazilian spellings stay out of the dictionary.
    for (const text of Object.values(pt)) {
      expect(text).not.toMatch(/\b(você|arquivo|tela|salvar|excluir)\b/i);
    }
  });

  it('picks the language from the setting, then from Obsidian', () => {
    expect(resolveLanguage('auto', 'pt-PT')).toBe('pt');
    expect(resolveLanguage('auto', 'pt')).toBe('pt');
    expect(resolveLanguage('auto', 'en-GB')).toBe('en');
    expect(resolveLanguage('auto', 'de')).toBe('en');
    expect(resolveLanguage('en', 'pt')).toBe('en');
    expect(resolveLanguage('pt', 'en')).toBe('pt');
    expect(loadSettings(null).language).toBe('auto');
    expect(loadSettings({ language: 'fr' }).language).toBe('auto');
  });
});
