// Pure view helpers over the block tree DTO: flattening for the
// virtualized outline, sibling/position lookups for keyboard commands.

import type { BlockSnapshot } from "../core-port/snapshot";

import { outlineIndex, type OutlineRow } from "../core-port/outline-index";
export type { OutlineRow } from "../core-port/outline-index";

/** Flattens the visible tree in document order, honoring collapsed nodes. */
export function flattenOutline(
  outline: { blocks: BlockSnapshot[] },
  collapsedIds: ReadonlySet<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let hiddenBelow: number | undefined;
  for (const row of outlineIndex(outline.blocks).values()) {
    if (hiddenBelow !== undefined && row.depth > hiddenBelow) continue;
    hiddenBelow = undefined;
    if (collapsedIds.has(row.block.id)) {
      rows.push({ ...row, collapsed: true });
      hiddenBelow = row.depth;
    } else rows.push(row);
  }
  return rows;
}

export function rowIndexOf(rows: OutlineRow[], blockId: string): number {
  return rows.findIndex((row) => row.block.id === blockId);
}
