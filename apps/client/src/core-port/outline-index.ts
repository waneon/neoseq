import type { BlockSnapshot } from "../generated/domain";

export interface OutlineRow {
  block: BlockSnapshot;
  depth: number;
  parentId: string | null;
  index: number;
  siblingCount: number;
  hasChildren: boolean;
  collapsed: boolean;
}

const indexes = new WeakMap<readonly BlockSnapshot[], ReadonlyMap<string, OutlineRow>>();
const positions = new WeakMap<BlockSnapshot, OutlineRow>();

/** Immutable trees share both their document-order index and unchanged row positions. */
export function outlineIndex(blocks: readonly BlockSnapshot[]): ReadonlyMap<string, OutlineRow> {
  const cached = indexes.get(blocks);
  if (cached) return cached;
  const rows = new Map<string, OutlineRow>();
  const visit = (children: readonly BlockSnapshot[], depth: number, parentId: string | null) => {
    children.forEach((block, index) => {
      let row = positions.get(block);
      if (
        !row ||
        row.depth !== depth ||
        row.parentId !== parentId ||
        row.index !== index ||
        row.siblingCount !== children.length
      ) {
        row = {
          block,
          depth,
          parentId,
          index,
          siblingCount: children.length,
          hasChildren: block.children.length > 0,
          collapsed: false,
        };
        positions.set(block, row);
      }
      rows.set(block.id, row);
      visit(block.children, depth + 1, block.id);
    });
  };
  visit(blocks, 0, null);
  indexes.set(blocks, rows);
  return rows;
}
