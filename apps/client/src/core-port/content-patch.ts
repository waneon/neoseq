import type { BlockContentSplice, InlineContent } from "./commands";
import type {
  BlockSnapshot,
  GraphSnapshot,
  OutlineOwner,
  PageDirectoryEntry,
  PageReferenceSpan,
} from "./snapshot";

type CanonicalUnit =
  | { type: "markdown"; value: string }
  | { type: "page_reference"; page_id: string };

function canonicalUnits(block: BlockSnapshot): CanonicalUnit[] {
  const points = Array.from(block.markdown);
  const references = [...(block.page_references ?? [])]
    .sort((left, right) => left.start - right.start);
  const units: CanonicalUnit[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start < cursor || reference.end > points.length) continue;
    for (const value of points.slice(cursor, reference.start)) {
      units.push({ type: "markdown", value });
    }
    units.push({ type: "page_reference", page_id: reference.page_id });
    cursor = reference.end;
  }
  for (const value of points.slice(cursor)) units.push({ type: "markdown", value });
  return units;
}

function insertedUnits(content: readonly InlineContent[]): CanonicalUnit[] {
  return content.flatMap((item) => item.type === "markdown"
    ? Array.from(item.value).map((value) => ({ type: "markdown" as const, value }))
    : [{ type: "page_reference" as const, page_id: item.page_id }]);
}

function materialize(
  block: BlockSnapshot,
  units: readonly CanonicalUnit[],
  directory: ReadonlyMap<string, PageDirectoryEntry>,
): BlockSnapshot {
  let markdown = "";
  let displayIndex = 0;
  const references: PageReferenceSpan[] = [];
  units.forEach((unit, index) => {
    if (unit.type === "markdown") {
      markdown += unit.value;
      displayIndex += 1;
      return;
    }
    const page = directory.get(unit.page_id);
    const title = page?.journal_date ?? page?.title ?? unit.page_id;
    const token = `[[${title}]]`;
    const length = Array.from(token).length;
    markdown += token;
    references.push({
      start: displayIndex,
      end: displayIndex + length,
      index,
      page_id: unit.page_id,
    });
    displayIndex += length;
  });
  return { ...block, markdown, page_references: references };
}

/**
 * Applies an acknowledged canonical content command to one hydrated outline.
 * Failure means the local read model was stale; callers must fall back to an
 * authoritative owner read rather than guessing through the mismatch.
 */
export function applyAcknowledgedContentSplices(
  snapshot: GraphSnapshot,
  owner: OutlineOwner,
  splices: readonly BlockContentSplice[],
): GraphSnapshot | null {
  if (splices.length === 0) return snapshot;
  const pending = new Map<string, BlockContentSplice[]>();
  for (const splice of splices) {
    const current = pending.get(splice.block_id);
    if (current) current.push(splice);
    else pending.set(splice.block_id, [splice]);
  }
  const directory = new Map(
    (snapshot.page_directory ?? []).map((page) => [page.id, page]),
  );
  let failed = false;
  const visit = (blocks: readonly BlockSnapshot[]): BlockSnapshot[] => blocks.map((block) => {
    let next = block;
    const blockSplices = pending.get(block.id);
    if (blockSplices) {
      let units = canonicalUnits(block);
      for (const splice of blockSplices) {
        if (splice.index < 0 || splice.delete < 0 || splice.index + splice.delete > units.length) {
          failed = true;
          break;
        }
        units = [
          ...units.slice(0, splice.index),
          ...insertedUnits(splice.insert),
          ...units.slice(splice.index + splice.delete),
        ];
      }
      if (!failed) next = materialize(block, units, directory);
      pending.delete(block.id);
    }
    const children = visit(block.children);
    if (children.some((child, index) => child !== block.children[index])) {
      next = { ...next, children };
    }
    return next;
  });

  if (owner.kind === "page") {
    const at = snapshot.pages.findIndex((page) => page.id === owner.id);
    if (at < 0) return null;
    const blocks = visit(snapshot.pages[at].blocks);
    if (failed || pending.size > 0) return null;
    const pages = [...snapshot.pages];
    pages[at] = { ...pages[at], blocks };
    return { ...snapshot, pages };
  }
  const at = snapshot.tags.findIndex((tag) => tag.id === owner.id);
  if (at < 0) return null;
  const blocks = visit(snapshot.tags[at].blocks);
  if (failed || pending.size > 0) return null;
  const tags = [...snapshot.tags];
  tags[at] = { ...tags[at], blocks };
  return { ...snapshot, tags };
}
