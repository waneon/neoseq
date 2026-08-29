// What a reader keeps to hand, and the order they keep it in.
//
// A favourite is one checkbox on the thing itself — `builtin.favorite` on a page
// or on a tag — rather than a list kept somewhere else. That is the whole design,
// and it is what a list would have had to buy back: nothing to keep in step when
// a page is deleted, nothing to reconcile when two replicas star the same thing,
// and no second place for a name to go stale. It travels with the graph rather
// than with the browser that starred it, because a graph opened on another
// machine is the same graph and the same handful of places worth returning to.
//
// The rail shows them in one list, pages and tags together, because "the things I
// come back to" is one thought and splitting it into two headings would ask the
// reader to remember which kind a thing was before they could find it.
//
// **The order is the reader's.** Alphabetical is an order nobody chose: the two
// pages someone lives in are wherever their names fell, and starring a third can
// push them apart. So the arrangement is a second number on the same owner —
// `builtin.favorite-order`, the model `entities/ordering` owns and the tag manager
// already uses. It is graph data because the list is: an arrangement kept in one
// browser would disagree with the favourites it arranges. Anything unarranged
// sorts after everything arranged, by name, so starring something lands it at the
// end instead of shuffling what is already in place — and unstarring leaves the
// number behind, so starring the same page again puts it back where it was.

import type { GraphSnapshot, PageSnapshot, TagSnapshot } from "../core-port/snapshot";
import { booleanValue, isDeleted, numberValue, pageKind, pageTitle } from "../core-port/snapshot";
import { moveWrites, place, type Placed } from "./ordering";

export const FAVOURITE_KEY = "builtin.favorite";
export const FAVOURITE_ORDER_KEY = "builtin.favorite-order";

export function isFavourite(entity: PageSnapshot | TagSnapshot): boolean {
  return booleanValue(entity.properties, FAVOURITE_KEY);
}

export function favouriteOrder(entity: PageSnapshot | TagSnapshot): number | null {
  const value = numberValue(entity.properties, FAVOURITE_ORDER_KEY);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

export type Favourite =
  | { kind: "page"; id: string; name: string; order: number | null }
  | { kind: "tag"; id: string; name: string; order: number | null; tag: TagSnapshot };

/**
 * Everything starred, in the reader's own order. A journal day is not offered: it
 * is reached by its date, and a favourite that names one day would be stale
 * tomorrow.
 */
export function favourites(
  snapshot: GraphSnapshot,
  compare: (left: string, right: string) => number,
): Favourite[] {
  const pages: Favourite[] = snapshot.pages
    .filter((page) => pageKind(page) === "regular" && !isDeleted(page) && isFavourite(page))
    .map((page) => ({
      kind: "page",
      id: page.id,
      name: pageTitle(page),
      order: favouriteOrder(page),
    }));
  const tags: Favourite[] = snapshot.tags.filter(isFavourite).map((tag) => ({
    kind: "tag",
    id: tag.id,
    name: tag.name,
    order: favouriteOrder(tag),
    tag,
  }));
  return [...pages, ...tags].sort(
    (left, right) => place(left.order, right.order) || compare(left.name, right.name),
  );
}

/**
 * One favourite's identity in this list. A page and a tag are separate namespaces,
 * so the kind travels with the id — the same key the rail already draws rows by.
 */
export function favouriteKey(entry: Favourite): string {
  return `${entry.kind}:${entry.id}`;
}

/** One favourite's new place, resolved back to the thing that has to be written. */
export interface FavouritePlacement {
  entry: Favourite;
  order: number;
}

/**
 * `moved` lifted out and dropped before `before` — or at the end when nothing
 * follows it — and the positions that record it. Returning the move as writes
 * rather than as a list is what lets a drag and a keyboard nudge be the same
 * operation.
 */
export function moveFavourite(
  ordered: readonly Favourite[],
  moved: Favourite,
  before: Favourite | null,
): FavouritePlacement[] {
  const key = favouriteKey(moved);
  // Landing before itself is standing still — which is what a drop just under
  // the row above is. Without this the row is lifted out first, `before` is then
  // a row the remainder no longer holds, and "stay put" becomes "go last".
  if (before !== null && favouriteKey(before) === key) return [];
  const rest = ordered.filter((entry) => favouriteKey(entry) !== key);
  const found =
    before === null ? -1 : rest.findIndex((entry) => favouriteKey(entry) === favouriteKey(before));
  const index = found < 0 ? rest.length : found;
  const next = [...rest.slice(0, index), moved, ...rest.slice(index)];
  const placed: Placed[] = next.map((entry) => ({ id: favouriteKey(entry), order: entry.order }));
  const byKey = new Map(next.map((entry) => [favouriteKey(entry), entry]));
  return moveWrites(placed, key).flatMap((write) => {
    const entry = byKey.get(write.id);
    return entry ? [{ entry, order: write.order }] : [];
  });
}
