// Structural selection over the flattened outline: which rows a drag covers,
// which of them are the roots of the moved subtrees, and where a drop lands.
//
// All of it is pure and index-based, which is what makes it safe next to the
// virtualizer. A rect-intersection marquee would only ever see the handful of
// rows currently mounted; a *range* between the row the drag started on and the
// row it is over now covers everything in between whether it is mounted or not.

import type { OutlineRow } from "../../entities/outline";

/**
 * The rows whose subtrees move. A row nested inside another selected row is a
 * passenger, not a root: moving the ancestor already carries it, and issuing a
 * second move for the child would tear it out of the subtree it just travelled
 * with.
 */
export function selectionRoots(
  rows: readonly OutlineRow[],
  selected: ReadonlySet<string>,
): OutlineRow[] {
  const roots: OutlineRow[] = [];
  let inside = -1;
  for (const row of rows) {
    if (inside >= 0 && row.depth <= inside) inside = -1;
    if (inside >= 0) continue;
    if (selected.has(row.block.id)) {
      roots.push(row);
      inside = row.depth;
    }
  }
  return roots;
}

/** Every row covered by the selection, roots and passengers alike. */
export function selectionSize(
  rows: readonly OutlineRow[],
  selected: ReadonlySet<string>,
): number {
  return coveredMask(rows, selected).reduce((total, covered) => total + (covered ? 1 : 0), 0);
}

/** `true` at every row that is a selected root or lives inside one. */
function coveredMask(
  rows: readonly OutlineRow[],
  ids: ReadonlySet<string>,
): boolean[] {
  const mask = rows.map(() => false);
  let inside = -1;
  rows.forEach((row, index) => {
    if (inside >= 0 && row.depth <= inside) inside = -1;
    if (inside >= 0) {
      mask[index] = true;
      return;
    }
    if (ids.has(row.block.id)) {
      mask[index] = true;
      inside = row.depth;
    }
  });
  return mask;
}

/** The ids in the inclusive row range `[from, to]`, in either drag direction. */
export function idsInRange(
  rows: readonly OutlineRow[],
  from: number,
  to: number,
): Set<string> {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(rows.length - 1, Math.max(from, to));
  const ids = new Set<string>();
  for (let index = start; index <= end; index += 1) ids.add(rows[index].block.id);
  return ids;
}

export interface DropTarget {
  parentId: string | null;
  /**
   * The child of `parentId` the group lands *after*, or `null` for the head of
   * the list. An anchor rather than an index, because an index is only true of
   * one moment: the core reads a move's index against the siblings that exist at
   * the time it runs, and the other movers are still among them.
   */
  afterId: string | null;
  depth: number;
  /** The gap the indicator sits in: 0 is above the first row, `rows.length` below the last. */
  gap: number;
}

/**
 * Where a drop at `gap`, nudged towards `desiredDepth` by the pointer's
 * horizontal position, actually lands.
 *
 * The legal depth range is the outliner rule: a row may sit at most one level
 * deeper than the row above it, and never shallower than the row below it — any
 * other depth would either orphan the row below or invent a level with no
 * parent. Rows inside a moving subtree are invisible to all of this, because
 * they are travelling with it.
 */
export function dropTarget(
  rows: readonly OutlineRow[],
  moving: ReadonlySet<string>,
  gap: number,
  desiredDepth: number,
): DropTarget | null {
  const mask = coveredMask(rows, moving);
  const clampedGap = Math.max(0, Math.min(rows.length, gap));

  let beforeIndex = clampedGap - 1;
  while (beforeIndex >= 0 && mask[beforeIndex]) beforeIndex -= 1;
  let afterIndex = clampedGap;
  while (afterIndex < rows.length && mask[afterIndex]) afterIndex += 1;

  const before = beforeIndex >= 0 ? rows[beforeIndex] : null;
  const after = afterIndex < rows.length ? rows[afterIndex] : null;

  // A collapsed row keeps its children; dropping "one level deeper" than it
  // would hide the dropped block, so it is not offered.
  const maxDepth = before ? (before.collapsed ? before.depth : before.depth + 1) : 0;
  const minDepth = after ? after.depth : 0;
  if (minDepth > maxDepth) return null;
  const depth = Math.max(minDepth, Math.min(maxDepth, desiredDepth));

  if (depth === 0) {
    return { parentId: null, afterId: lastSibling(rows, mask, 0, 0, beforeIndex), depth, gap: clampedGap };
  }

  // The parent is the nearest row above the gap that sits one level shallower.
  let parentIndex = beforeIndex;
  while (parentIndex >= 0 && rows[parentIndex].depth !== depth - 1) parentIndex -= 1;
  if (parentIndex < 0) return null;
  return {
    parentId: rows[parentIndex].block.id,
    afterId: lastSibling(rows, mask, depth, parentIndex + 1, beforeIndex),
    depth,
    gap: clampedGap,
  };
}

/** The last row at `depth` in `[from, to]` that is not travelling with the drag. */
function lastSibling(
  rows: readonly OutlineRow[],
  mask: readonly boolean[],
  depth: number,
  from: number,
  to: number,
): string | null {
  for (let cursor = to; cursor >= from; cursor -= 1) {
    if (rows[cursor].depth === depth && !mask[cursor]) return rows[cursor].block.id;
  }
  return null;
}
