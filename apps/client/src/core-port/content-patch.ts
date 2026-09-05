import type { BlockContentUpdate, BlockSnapshot, GraphSnapshot } from "./snapshot";
import { outlineOwnerKey } from "./snapshot";

/** Installs authoritative values. Unhydrated owners remain demand reads. */
export function applyContentUpdates(
  snapshot: GraphSnapshot,
  updates: readonly BlockContentUpdate[],
): GraphSnapshot {
  const byOwner = new Map<string, Map<string, BlockContentUpdate>>();
  for (const update of updates) {
    const key = outlineOwnerKey(update.owner);
    const blocks = byOwner.get(key) ?? new Map();
    blocks.set(update.block_id, update);
    byOwner.set(key, blocks);
  }
  const visit = (
    blocks: BlockSnapshot[],
    updates: Map<string, BlockContentUpdate>,
  ): BlockSnapshot[] => {
    let changed = false;
    const next = blocks.map((block) => {
      const children = visit(block.children, updates);
      const update = updates.get(block.id);
      if (!update && children === block.children) return block;
      changed = true;
      return update
        ? {
            ...block,
            content: update.content,
            markdown: update.markdown,
            page_references: update.page_references,
            properties: update.properties,
            children,
          }
        : { ...block, children };
    });
    return changed ? next : blocks;
  };
  const owners = <T extends { id: string; blocks: BlockSnapshot[] }>(
    items: T[],
    kind: "page" | "tag",
  ): T[] => {
    let changed = false;
    const next = items.map((item) => {
      const updates = byOwner.get(outlineOwnerKey({ kind, id: item.id }));
      if (!updates) return item;
      const blocks = visit(item.blocks, updates);
      if (blocks === item.blocks) return item;
      changed = true;
      return { ...item, blocks };
    });
    return changed ? next : items;
  };
  const pages = owners(snapshot.pages, "page");
  const tags = owners(snapshot.tags, "tag");
  return pages === snapshot.pages && tags === snapshot.tags
    ? snapshot
    : { ...snapshot, pages, tags };
}
