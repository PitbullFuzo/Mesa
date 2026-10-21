/** Adds or removes one id in a selection list, in place. */
export function toggleIn(list: string[], value: string, on: boolean): void {
  const index = list.indexOf(value);
  if (on && index < 0) list.push(value);
  if (!on && index >= 0) list.splice(index, 1);
}

/**
 * The items a search box shows: those whose search text contains the query, case-insensitively.
 * It only filters what is shown; the selection list is never changed by a search.
 */
export function filterPickItems<T extends { search: string }>(
  items: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => item.search.includes(needle));
}
