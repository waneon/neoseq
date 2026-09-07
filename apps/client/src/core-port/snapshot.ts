import { outlineIndex } from "./outline-index";
// Read-only projections and helpers over generated domain DTOs.
import type {
  PropertyDocument,
  PropertyValue,
  PropertyField,
  BlockSnapshot,
  PageReferenceSpan,
  PageDirectoryEntry,
  OutlineOwner,
  OutlineSnapshot,
  PageSnapshot,
  TagSnapshot,
  GraphSummary,
  GraphSnapshot,
} from "../generated/domain";
export type {
  PropertyType as PropertyValueType,
  QueryViewKind,
  QueryViewColumn,
  QueryViewSort,
  QueryViewFieldSort,
  QueryViewOptions,
  QueryView,
  QueryPlan as QueryPlanDocument,
  QueryDefinition,
  PropertyDocument,
  DefaultQuerySnapshot,
  GraphSettings,
  QueryOwner,
  TextTarget,
  PropertyValue,
  PropertyField,
  BlockSnapshot,
  ContentRangeChange,
  BlockContentUpdate,
  GraphChanges,
  PageReferenceSpan,
  PageDirectoryEntry,
  OutlineOwner,
  OutlineSnapshot,
  PageSnapshot,
  TagSnapshot,
  GraphConflict,
  GraphSummary,
  GraphSnapshot,
} from "../generated/domain";

export const EMPTY_SNAPSHOT: GraphSnapshot = {
  schema_version: 7,
  graph_id: "",
  pages: [],
  page_directory: [],
  tags: [],
  settings: { default_queries: [] },
  conflicts: [],
  quarantined: [],
};

export function mergeSummary(
  summary: GraphSummary,
  current: GraphSnapshot = EMPTY_SNAPSHOT,
): GraphSnapshot {
  const directory = new Map((summary.page_directory ?? []).map((page) => [page.id, page]));
  const hydrate = (blocks: readonly BlockSnapshot[]) =>
    blocks.map((block) => rematerializeBlock(block, directory));
  const hydratedPages = new Map(current.pages.map((page) => [page.id, hydrate(page.blocks)]));
  const hydratedTags = new Map(current.tags.map((tag) => [tag.id, hydrate(tag.blocks)]));
  return {
    ...summary,
    pages: summary.pages.map((page) => ({ ...page, blocks: hydratedPages.get(page.id) ?? [] })),
    tags: summary.tags.map((tag) => ({ ...tag, blocks: hydratedTags.get(tag.id) ?? [] })),
  };
}

const directories = new WeakMap<
  readonly PageDirectoryEntry[],
  ReadonlyMap<string, PageDirectoryEntry>
>();
export function pageDirectoryIndex(
  pages: readonly PageDirectoryEntry[],
): ReadonlyMap<string, PageDirectoryEntry> {
  let index = directories.get(pages);
  if (!index) {
    index = new Map(pages.map((page) => [page.id, page]));
    directories.set(pages, index);
  }
  return index;
}

/** Projects semantic content; display offsets never become an editing baseline. */
export function projectInlineContent(
  content: readonly import("./commands").InlineContent[],
  pages: readonly PageDirectoryEntry[] | ReadonlyMap<string, PageDirectoryEntry>,
): { markdown: string; pageReferences: PageReferenceSpan[] } {
  const directory: ReadonlyMap<string, PageDirectoryEntry> = isPageDirectoryMap(pages)
    ? pages
    : pageDirectoryIndex(pages);
  let markdown = "";
  let display = 0;
  let index = 0;
  const pageReferences: PageReferenceSpan[] = [];
  for (const part of content) {
    if (part.type === "markdown") {
      markdown += part.value;
      const length = Array.from(part.value).length;
      display += length;
      index += length;
    } else {
      const page = directory.get(part.page_id);
      const token = `[[${page?.journal_date ?? page?.title ?? part.page_id}]]`;
      const end = display + Array.from(token).length;
      pageReferences.push({ start: display, end, index, page_id: part.page_id });
      markdown += token;
      display = end;
      index += 1;
    }
  }
  return { markdown, pageReferences };
}

function isPageDirectoryMap(
  pages: readonly PageDirectoryEntry[] | ReadonlyMap<string, PageDirectoryEntry>,
): pages is ReadonlyMap<string, PageDirectoryEntry> {
  return !Array.isArray(pages);
}

function rematerializeBlock(
  block: BlockSnapshot,
  directory: ReadonlyMap<string, PageDirectoryEntry>,
): BlockSnapshot {
  const children = block.children.map((child) => rematerializeBlock(child, directory));
  const childrenChanged = children.some((child, index) => child !== block.children[index]);
  const references = block.page_references ?? [];
  if (references.length === 0) {
    return childrenChanged ? { ...block, children } : block;
  }
  const projection = projectInlineContent(block.content, directory);
  const referencesChanged =
    projection.pageReferences.length !== references.length ||
    projection.pageReferences.some((reference, index) => {
      const current = references[index];
      return (
        current === undefined ||
        reference.start !== current.start ||
        reference.end !== current.end ||
        reference.index !== current.index ||
        reference.page_id !== current.page_id
      );
    });
  if (!childrenChanged && projection.markdown === block.markdown && !referencesChanged) {
    return block;
  }
  return {
    ...block,
    markdown: projection.markdown,
    page_references: projection.pageReferences,
    children,
  };
}

export function mergePage(snapshot: GraphSnapshot, page: PageSnapshot): GraphSnapshot {
  return {
    ...snapshot,
    pages: snapshot.pages.map((current) => (current.id === page.id ? page : current)),
  };
}

export function mergeOutline(snapshot: GraphSnapshot, outline: OutlineSnapshot): GraphSnapshot {
  if (outline.owner.kind === "page") {
    return {
      ...snapshot,
      pages: snapshot.pages.map((page) =>
        page.id === outline.owner.id ? { ...page, blocks: outline.blocks } : page,
      ),
    };
  }
  return {
    ...snapshot,
    tags: snapshot.tags.map((tag) =>
      tag.id === outline.owner.id ? { ...tag, blocks: outline.blocks } : tag,
    ),
  };
}

function propertyField(bag: PropertyField[], key: string): PropertyField | undefined {
  return bag.find((field) => field.key === key);
}

function singleValue(bag: PropertyField[], key: string): PropertyValue | undefined {
  return propertyField(bag, key)?.values[0];
}

export function stringValue(bag: PropertyField[], key: string): string | undefined {
  const value = singleValue(bag, key);
  return value?.type === "string" ? value.value : undefined;
}

export function queryDocument(bag: PropertyField[]): PropertyDocument | undefined {
  const value = singleValue(bag, "builtin.query");
  return value?.type === "document" && value.value.schema === "neoseq.query"
    ? value.value
    : undefined;
}

export function numberValue(bag: PropertyField[], key: string): number | undefined {
  const value = singleValue(bag, key);
  return value?.type === "number" ? value.value : undefined;
}

export function dateValue(bag: PropertyField[], key: string): string | undefined {
  const value = singleValue(bag, key);
  return value?.type === "date" ? value.value : undefined;
}

export function pageTitle(page: PageSnapshot): string {
  // Journals are named by their semantic date, just like page-directory entries.
  return journalDate(page) ?? (page.title || page.id);
}

export function pageKind(page: PageSnapshot): "regular" | "journal" {
  return stringValue(page.properties, "builtin.page-kind") === "journal" ? "journal" : "regular";
}

export function journalDate(page: PageSnapshot): string | undefined {
  return dateValue(page.properties, "builtin.journal-date");
}

export function booleanValue(bag: PropertyField[], key: string): boolean {
  const value = singleValue(bag, key);
  return value?.type === "checkbox" && value.value;
}

export function isDeleted(page: PageSnapshot): boolean {
  return singleValue(page.properties, "builtin.deleted-at") !== undefined;
}

export function findPage(snapshot: GraphSnapshot, pageId: string): PageSnapshot | undefined {
  return snapshot.pages.find((page) => page.id === pageId);
}

export function outlineOwnerKey(owner: OutlineOwner): string {
  return `${owner.kind}:${owner.id}`;
}

export function sameOutlineOwner(left: OutlineOwner, right: OutlineOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function findOutline(
  snapshot: GraphSnapshot,
  owner: OutlineOwner,
): PageSnapshot | TagSnapshot | undefined {
  return owner.kind === "page" ? findPage(snapshot, owner.id) : findTag(snapshot, owner.id);
}

export function findJournalPage(snapshot: GraphSnapshot, date: string): PageSnapshot | undefined {
  return snapshot.pages.find((page) => pageKind(page) === "journal" && journalDate(page) === date);
}

export function findBlock(
  outline: { blocks: BlockSnapshot[] },
  blockId: string,
): BlockSnapshot | undefined {
  return outlineIndex(outline.blocks).get(blockId)?.block;
}

export function findTag(snapshot: GraphSnapshot, tagId: string): TagSnapshot | undefined {
  return snapshot.tags.find((tag) => tag.id === tagId);
}
