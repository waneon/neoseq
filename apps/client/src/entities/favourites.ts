// What a reader keeps to hand.
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

import type { GraphSnapshot, PageSnapshot, TagSnapshot } from "../core-port/snapshot";
import { booleanValue, isDeleted, pageKind, pageTitle } from "../core-port/snapshot";

export const FAVOURITE_KEY = "builtin.favorite";

export function isFavourite(entity: PageSnapshot | TagSnapshot): boolean {
  return booleanValue(entity.properties, FAVOURITE_KEY);
}

export type Favourite =
  | { kind: "page"; id: string; name: string }
  | { kind: "tag"; id: string; name: string; tag: TagSnapshot };

/**
 * Everything starred, in one collation. A journal day is not offered: it is
 * reached by its date, and a favourite that names one day would be stale
 * tomorrow.
 */
export function favourites(
  snapshot: GraphSnapshot,
  compare: (left: string, right: string) => number,
): Favourite[] {
  const pages: Favourite[] = snapshot.pages
    .filter((page) => pageKind(page) === "regular" && !isDeleted(page) && isFavourite(page))
    .map((page) => ({ kind: "page", id: page.id, name: pageTitle(page) }));
  const tags: Favourite[] = snapshot.tags
    .filter(isFavourite)
    .map((tag) => ({ kind: "tag", id: tag.id, name: tag.name, tag }));
  return [...pages, ...tags].sort((left, right) => compare(left.name, right.name));
}
