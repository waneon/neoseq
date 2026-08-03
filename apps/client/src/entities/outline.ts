// Pure view helpers over the block tree DTO: flattening for the
// virtualized outline, sibling/position lookups for keyboard commands.

import type { BlockSnapshot, PageSnapshot } from "../core-port/snapshot";

export interface OutlineRow {
  block: BlockSnapshot;
  depth: number;
  parentId: string | null;
  /** Index among its siblings. */
  index: number;
  siblingCount: number;
  hasChildren: boolean;
  collapsed: boolean;
}

/** Flattens the visible tree in document order, honoring collapsed nodes. */
export function flattenOutline(page: PageSnapshot, collapsedIds: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (blocks: BlockSnapshot[], depth: number, parentId: string | null) => {
    blocks.forEach((block, index) => {
      const collapsed = collapsedIds.has(block.id);
      rows.push({
        block,
        depth,
        parentId,
        index,
        siblingCount: blocks.length,
        hasChildren: block.children.length > 0,
        collapsed,
      });
      if (!collapsed) walk(block.children, depth + 1, block.id);
    });
  };
  walk(page.blocks, 0, null);
  return rows;
}

export function rowIndexOf(rows: OutlineRow[], blockId: string): number {
  return rows.findIndex((row) => row.block.id === blockId);
}

export function subtreeSize(block: BlockSnapshot): number {
  return 1 + block.children.reduce((total, child) => total + subtreeSize(child), 0);
}
