// The one number a reader's own order is kept as, and the two lists that keep it.

import { describe, expect, it } from "vitest";
import {
  ORDER_STEP,
  moveWrites,
  nextOrder,
  place,
  respace,
} from "../../src/entities/ordering";
import {
  FAVOURITE_KEY,
  FAVOURITE_ORDER_KEY,
  favourites,
  moveFavourite,
} from "../../src/entities/favourites";
import {
  EMPTY_SNAPSHOT,
  type GraphSnapshot,
  type PageSnapshot,
  type PropertyField,
  type TagSnapshot,
} from "../../src/core-port/snapshot";

const compare = (left: string, right: string) => left.localeCompare(right, "en");

function starred(order?: number): PropertyField[] {
  const fields: PropertyField[] = [
    { key: FAVOURITE_KEY, value_type: "checkbox", cardinality: "single", values: [{ type: "checkbox", value: true }] },
  ];
  if (order !== undefined) {
    fields.push({
      key: FAVOURITE_ORDER_KEY,
      value_type: "number",
      cardinality: "single",
      values: [{ type: "number", value: order }],
    });
  }
  return fields;
}

function page(id: string, title: string, order?: number): PageSnapshot {
  return { id, title, properties: starred(order), tags: [], blocks: [] };
}

function tag(id: string, name: string, order?: number): TagSnapshot {
  return { id, name, properties: starred(order), defaults: [], blocks: [] };
}

function graph(pages: PageSnapshot[], tags: TagSnapshot[]): GraphSnapshot {
  return { ...EMPTY_SNAPSHOT, pages, tags };
}

describe("fractional positions", () => {
  it("puts what is placed before what is not, and leaves the rest to the caller", () => {
    expect(place(1, 2)).toBeLessThan(0);
    expect(place(2, 1)).toBeGreaterThan(0);
    expect(place(1, null)).toBeLessThan(0);
    expect(place(null, 1)).toBeGreaterThan(0);
    // Indistinguishable here: the caller falls back to a name.
    expect(place(null, null)).toBe(0);
    expect(place(1, 1)).toBe(0);
  });

  it("writes only what moved when its new neighbours are known", () => {
    const items = [
      { id: "a", order: 0 },
      { id: "c", order: 2 * ORDER_STEP },
      { id: "b", order: ORDER_STEP },
    ];
    expect(moveWrites(items, "c")).toEqual([{ id: "c", order: ORDER_STEP / 2 }]);
    // Both ends open onto a step of their own rather than onto a neighbour.
    expect(moveWrites([{ id: "b", order: ORDER_STEP }, { id: "a", order: 0 }], "b"))
      .toEqual([{ id: "b", order: -ORDER_STEP }]);
  });

  it("respaces a run that has no midpoint to take", () => {
    // Nobody has arranged this list, so there is nothing to halve.
    const fresh = [{ id: "a", order: null }, { id: "b", order: null }];
    expect(moveWrites(fresh, "b")).toEqual(respace(fresh));
    // An exhausted gap: the halves stop being distinguishable at a double's
    // precision, so the whole run is given fresh room.
    const tight = [{ id: "a", order: 0 }, { id: "m", order: 1 }, { id: "b", order: 1 / 4096 }];
    expect(moveWrites(tight, "m")).toEqual(respace(tight));
    expect(moveWrites(fresh, "absent")).toEqual([]);
  });

  it("puts something new after everything already arranged", () => {
    expect(nextOrder([])).toBe(ORDER_STEP);
    expect(nextOrder([{ id: "a", order: 5 }, { id: "b", order: null }])).toBe(5 + ORDER_STEP);
  });
});

describe("the starred list", () => {
  it("reads pages and tags as one list, arranged first and named after", () => {
    const snapshot = graph(
      [page("p1", "Zebra", 0), page("p2", "Apple")],
      [tag("t1", "Reading", ORDER_STEP)],
    );
    expect(favourites(snapshot, compare).map((entry) => entry.name))
      .toEqual(["Zebra", "Reading", "Apple"]);
  });

  it("moves one row and writes one position", () => {
    const snapshot = graph(
      [page("p1", "Alpha", 0), page("p2", "Beta", ORDER_STEP)],
      [tag("t1", "Reading", 2 * ORDER_STEP)],
    );
    const ordered = favourites(snapshot, compare);
    const reading = ordered[2];
    expect(moveFavourite(ordered, reading, ordered[1]))
      .toEqual([{ entry: reading, order: ORDER_STEP / 2 }]);
    // Dropped past the end, with nothing following to land before.
    expect(moveFavourite(ordered, ordered[0], null))
      .toEqual([{ entry: ordered[0], order: 3 * ORDER_STEP }]);
  });

  it("stands still when a row lands just under the one above it", () => {
    const snapshot = graph(
      [page("p1", "Alpha", 0), page("p2", "Beta", ORDER_STEP)],
      [tag("t1", "Reading", 2 * ORDER_STEP)],
    );
    const ordered = favourites(snapshot, compare);
    // The seam under Alpha resolves to "before Beta", which is where Beta is.
    expect(moveFavourite(ordered, ordered[1], ordered[1])).toEqual([]);
  });

  it("keeps a page and a tag apart when they share an id", () => {
    const snapshot = graph([page("same", "Page", 0)], [tag("same", "Tag", ORDER_STEP)]);
    const ordered = favourites(snapshot, compare);
    // Only the tag moves, even though the page answers to the same id.
    expect(moveFavourite(ordered, ordered[1], ordered[0]))
      .toEqual([{ entry: ordered[1], order: -ORDER_STEP }]);
  });
});
