import { useProgressiveItems } from "../../lib/progressive";

export const QUERY_ROW_WINDOW = 100;

/**
 * Keeps a query answer complete while bounding the DOM created in one frame.
 * A changed answer renders its first window immediately; the layout effect only
 * synchronizes the remembered count, so an older expanded answer never flashes.
 */
export function useProgressiveRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  pinnedKey?: string,
) {
  const window = useProgressiveItems(rows, keyOf, QUERY_ROW_WINDOW, pinnedKey);
  return {
    rows: window.items,
    remaining: window.remaining,
    showMore: window.showMore,
  };
}
