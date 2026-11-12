/** Mesa's pages, in the order the "Mesa" ribbon menu lists them. */
export const MESA_PAGES = [
  { id: 'activity', label: 'Live activity', icon: 'activity' },
  { id: 'projects', label: 'Projects', icon: 'folder-kanban' },
  { id: 'schedules', label: 'Schedules', icon: 'calendar-clock' },
  { id: 'skills', label: 'Skills', icon: 'book-open' },
  { id: 'overview', label: 'Vault overview', icon: 'circle-dot' },
  { id: 'graph', label: 'AI Graph', icon: 'network' },
  { id: 'obi', label: 'Obi', icon: 'sparkles' },
  { id: 'chat', label: 'Mesa chat', icon: 'message-circle' },
] as const;

export type MesaPageId = (typeof MESA_PAGES)[number]['id'];

/** Pages that always have their own ribbon icon. The others only get one when the owner ticks them. */
export const ALWAYS_ON_RIBBON: readonly MesaPageId[] = ['obi', 'chat', 'graph'];

/** The pages the owner may tick under Settings → Ribbon icons. */
export const OPTIONAL_RIBBON_PAGES = MESA_PAGES.filter(
  (page) => !ALWAYS_ON_RIBBON.includes(page.id),
);

export function isOptionalRibbonPage(id: string): boolean {
  return OPTIONAL_RIBBON_PAGES.some((page) => page.id === id);
}

/** Ticks or unticks one extra page icon; unknown ids are dropped. */
export function toggleRibbonExtra(
  current: readonly string[],
  id: string,
  on: boolean,
): string[] {
  const next = new Set(current.filter(isOptionalRibbonPage));
  if (isOptionalRibbonPage(id)) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return OPTIONAL_RIBBON_PAGES.map((page) => page.id).filter((pageId) =>
    next.has(pageId),
  );
}
