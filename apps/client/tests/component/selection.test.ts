// Structural selection arithmetic. All of it is pure, and all of it is the part
// a drag can get wrong in ways that silently reshape someone's outline — which is
// why it lives outside the component and is tested directly.

import { describe, expect, it } from "vitest";
import { flattenOutline } from "../../src/entities/outline";
import type { BlockSnapshot, PageSnapshot } from "../../src/core-port/snapshot";
import {
  dropTarget,
  idsInRange,
  movePlan,
  outdentOrder,
  selectionRoots,
  selectionSize,
} from "../../src/features/outline/selection";

function block(id: string, children: BlockSnapshot[] = []): BlockSnapshot {
  return { id, markdown: id, properties: [], tags: [], children };
}

/**
 *   a
 *   b
 *     b1
 *     b2
 *   c
 */
const PAGE: PageSnapshot = {
  id: "page",
  properties: [],
  blocks: [block("a"), block("b", [block("b1"), block("b2")]), block("c")],
} as unknown as PageSnapshot;

const rows = flattenOutline(PAGE, new Set());

describe("selection roots", () => {
  it("drops a row that is already travelling inside a selected ancestor", () => {
    const roots = selectionRoots(rows, new Set(["b", "b1", "b2"]));
    expect(roots.map((row) => row.block.id)).toEqual(["b"]);
  });

  it("keeps siblings at the same level as separate roots", () => {
    const roots = selectionRoots(rows, new Set(["a", "c"]));
    expect(roots.map((row) => row.block.id)).toEqual(["a", "c"]);
  });

  it("counts the passengers, not just the roots", () => {
    expect(selectionSize(rows, new Set(["b"]))).toBe(3);
    expect(selectionSize(rows, new Set(["a", "c"]))).toBe(2);
  });

  it("reads a dragged range in either direction", () => {
    expect([...idsInRange(rows, 3, 1)]).toEqual(["b", "b1", "b2"]);
    expect([...idsInRange(rows, 0, 99)]).toEqual(["a", "b", "b1", "b2", "c"]);
  });
});

describe("drop targets", () => {
  const moving = new Set(["a"]);

  it("anchors a root-level drop to the last root above it, ignoring the mover", () => {
    // Between `b2` and `c`: still depth 0, and `a` is travelling, so `b` is what
    // the group lands after.
    expect(dropTarget(rows, moving, 4, 0)).toMatchObject({
      parentId: null,
      afterId: "b",
      depth: 0,
    });
  });

  it("clamps the depth to one level deeper than the row above the gap", () => {
    // Dropping just under `b` may become b's first child, but never a grandchild.
    expect(dropTarget(rows, moving, 2, 9)).toMatchObject({
      parentId: "b",
      depth: 1,
      afterId: null,
    });
    expect(dropTarget(rows, moving, 2, 0)).toMatchObject({ parentId: "b", depth: 1 });
  });

  it("never lets a drop land shallower than the row beneath it", () => {
    // Between b1 and b2, depth 0 would orphan b2, so the depth is held at 1.
    expect(dropTarget(rows, moving, 3, 0)).toMatchObject({
      parentId: "b",
      depth: 1,
      afterId: "b1",
    });
  });

  it("refuses to drop a subtree inside itself", () => {
    // Every gap between b's own rows is invisible to a drag of b: the gap after
    // b1 resolves against the rows outside the moving subtree instead.
    const target = dropTarget(rows, new Set(["b"]), 3, 1);
    expect(target?.parentId).not.toBe("b");
  });

  it("does not offer a level inside a collapsed row, which would hide the drop", () => {
    const collapsed = flattenOutline(PAGE, new Set(["b"]));
    expect(dropTarget(collapsed, moving, 2, 9)).toMatchObject({ parentId: null, depth: 0 });
  });
});

describe("move plans", () => {
  it("walks an anchor, so each root lands after the one before it", () => {
    const roots = selectionRoots(rows, new Set(["a", "c"]));
    expect(
      movePlan(rows, roots, { parentId: "b", afterId: "b2", depth: 1, gap: 4 }),
    ).toEqual([
      { blockId: "a", parent: "b", index: 2 },
      { blockId: "c", parent: "b", index: 3 },
    ]);
  });

  it("counts against the siblings that still exist, not the ones that will", () => {
    // `a` and `b` both move to the end of the roots, past `c`. Naively that is
    // index 1 then 2, which lands them as c, a … then a, c, b — the order the
    // user did not ask for. Anchored, `a` goes after `c` and `b` after `a`.
    const roots = selectionRoots(rows, new Set(["a", "b"]));
    const target = dropTarget(rows, new Set(["a", "b"]), 5, 0);
    expect(target).toMatchObject({ parentId: null, afterId: "c" });
    expect(movePlan(rows, roots, target!)).toEqual([
      { blockId: "a", parent: null, index: 2 },
      { blockId: "b", parent: null, index: 2 },
    ]);
  });

  it("puts a group at the head of a list when there is nothing above it", () => {
    const roots = selectionRoots(rows, new Set(["b", "c"]));
    expect(
      movePlan(rows, roots, { parentId: null, afterId: null, depth: 0, gap: 0 }),
    ).toEqual([
      { blockId: "b", parent: null, index: 0 },
      { blockId: "c", parent: null, index: 1 },
    ]);
  });

  it("outdents from the bottom up, so the group keeps its order", () => {
    const roots = selectionRoots(rows, new Set(["b1", "b2"]));
    expect(outdentOrder(roots).map((row) => row.block.id)).toEqual(["b2", "b1"]);
  });
});
