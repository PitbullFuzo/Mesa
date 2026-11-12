import * as obsidian from 'obsidian';

/**
 * Obsidian's own interface language ("en", "pt", "pt-BR" …). getLanguage() only exists from Obsidian 1.8.7, so it is
 * looked up by name; older versions fall back to moment's locale.
 */
export function obsidianLanguage(): string {
  try {
    const getter = (obsidian as unknown as Record<string, unknown>)[
      'getLanguage'
    ];
    if (typeof getter === 'function') {
      const language: unknown = (getter as () => unknown)();
      if (typeof language === 'string' && language) return language;
    }
  } catch {
    /* Fall through to moment. */
  }
  try {
    return obsidian.moment.locale();
  } catch {
    return 'en';
  }
}
