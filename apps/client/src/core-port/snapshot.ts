// Immutable DTO shapes produced by the Rust core (`domain::GraphSnapshot`).
// The UI renders these views and never mutates them locally.

export type PropertyValueType = "number" | "string" | "page" | "checkbox" | "date" | "document";

export type QueryViewKind = "table" | "list";

export interface QueryViewColumn {
  variable: string;
  hidden: boolean;
  width: number | null;
}

/**
 * One term of the order a saved view lays its rows out in — presentation, not
 * semantics: it reorders the rows the query already returned. An order that a
 * `LIMIT` cuts against belongs to the executable query.
 */
export interface QueryViewSort {
  variable: string;
  descending: boolean;
}

/** A canonical entity field used to order a list independently of table columns. */
export interface QueryViewFieldSort {
  field: string;
  descending: boolean;
}

export interface QueryViewOptions {
  compact: boolean;
  wrap: boolean;
  /**
   * A table's projected-column order, most significant first. Absent or empty
   * means the order the query returned. The domain reads the single object
   * earlier builds wrote as a one-term list, so an order saved then still applies.
   */
  sort?: QueryViewSort[] | null;
  /** A list's canonical-field order, independent of projected result columns. */
  list_sort?: QueryViewFieldSort[];
}

export interface QueryView {
  id: string;
  name: string;
  definition: QueryDefinition;
  kind: QueryViewKind;
  position: number;
  columns: QueryViewColumn[];
  options: QueryViewOptions;
}

/**
 * The builder's authoritative query representation. `payload` holds the
 * generated CorePort grammar; projected source is only a core-derived
 * explanation. An unknown version remains unsupported and is never executed
 * as raw source.
 */
export interface QueryPlanDocument {
  version: number;
  payload: string;
}

export interface QueryDefinition {
  source: string;
  language: "sparql-1.1/neoseq-v1";
  plan?: QueryPlanDocument | null;
}

export interface PropertyDocument {
  schema: "neoseq.query";
  version: 2;
  views: QueryView[];
  default_view_id: string;
}

export interface DefaultQuerySnapshot {
  id: string;
  title: string;
  position: number;
  document: PropertyDocument;
}

export interface GraphSettings {
  /** Bounded `(position, id)` projection; overflow remains canonical conflict data. */
  default_queries: DefaultQuerySnapshot[];
}

export type QueryOwner =
  | { kind: "page"; id: string }
  | { kind: "block"; owner: OutlineOwner; id: string }
  | { kind: "tag"; tag_id: string }
  | { kind: "graph_default"; default_query_id: string };

/** Collaborative text whose complete value may exceed a local byte budget. */
export type TextTarget =
  | { kind: "page_title"; page_id: string }
  | { kind: "block_content"; owner: OutlineOwner; block_id: string }
  | { kind: "query_source"; owner: QueryOwner; view_id: string };

export type PropertyValue =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "page"; value: string }
  | { type: "checkbox"; value: boolean }
  | { type: "date"; value: string }
  | { type: "document"; value: PropertyDocument }
  | { type: "unsupported_document"; value: { schema: string; version: number } };

export interface PropertyField {
  key: string;
  value_type: PropertyValueType;
  cardinality: "single" | "set";
  values: PropertyValue[];
}

export interface BlockSnapshot {
  id: string;
  /** Semantic content; markdown and spans are disposable display projections. */
  content: import("./commands").InlineContent[];
  /** Current-title projection; page-reference identity lives in `page_references`. */
  markdown: string;
  page_references?: PageReferenceSpan[];
  properties: PropertyField[];
  tags: string[];
  children: BlockSnapshot[];
}

export interface ContentRangeChange {
  index: number;
  delete: number;
  insert: number;
}

export interface BlockContentUpdate {
  owner: OutlineOwner;
  block_id: string;
  content: import("./commands").InlineContent[];
  markdown: string;
  page_references: PageReferenceSpan[];
  properties: PropertyField[];
  mapping: ContentRangeChange[];
}

export type GraphChanges =
  | { kind: "content"; blocks: BlockContentUpdate[] }
  | { kind: "refresh"; outlines: OutlineOwner[] | null; blocks: BlockContentUpdate[] };

export interface PageReferenceSpan {
  /** Unicode-scalar range in `markdown`. */
  start: number;
  end: number;
  /** Canonical inline-content position occupied by the one reference atom. */
  index: number;
  page_id: string;
}

export interface PageDirectoryEntry {
  id: string;
  /** Shared source label: the page title, or the ISO date for a journal. */
  title: string;
  journal_date: string | null;
  deleted: boolean;
}

export type OutlineOwner = { kind: "page"; id: string } | { kind: "tag"; id: string };

export interface OutlineSnapshot {
  owner: OutlineOwner;
  blocks: BlockSnapshot[];
}

export interface PageSnapshot {
  id: string;
  title: string;
  properties: PropertyField[];
  tags: string[];
  blocks: BlockSnapshot[];
}

interface PageSummary {
  id: string;
  title: string;
  properties: PropertyField[];
  tags: string[];
}

export interface TagSnapshot {
  id: string;
  name: string;
  properties: PropertyField[];
  defaults: PropertyField[];
  blocks: BlockSnapshot[];
}

type TagSummary = Omit<TagSnapshot, "blocks">;

/** A valid collaborative state that needs an explicit user choice to resolve. */
export type GraphConflict =
  | { kind: "duplicate_page_name"; canonical_name: string; page_ids: string[] }
  | { kind: "duplicate_tag_name"; canonical_name: string; tag_ids: string[] }
  | { kind: "default_query_overflow"; overflow_ids: string[] }
  | { kind: "query_view_overflow"; owner: QueryOwner; overflow_ids: string[] }
  | {
      kind: "query_default_view_unavailable";
      owner: QueryOwner;
      requested_view_id: string;
      fallback_view_id: string;
    }
  | {
      kind: "text_limit_exceeded";
      target: TextTarget;
      actual_bytes: number;
      limit: number;
    };

export interface GraphSummary {
  schema_version: number;
  graph_id: string;
  pages: PageSummary[];
  page_directory?: PageDirectoryEntry[];
  tags: TagSummary[];
  settings: GraphSettings;
  conflicts: GraphConflict[];
  quarantined: string[];
}

export interface GraphSnapshot {
  schema_version: number;
  graph_id: string;
  pages: PageSnapshot[];
  page_directory?: PageDirectoryEntry[];
  tags: TagSnapshot[];
  settings: GraphSettings;
  conflicts: GraphConflict[];
  quarantined: string[];
}

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

/** Projects semantic content; display offsets never become an editing baseline. */
export function projectInlineContent(
  content: readonly import("./commands").InlineContent[],
  pages: readonly PageDirectoryEntry[] | ReadonlyMap<string, PageDirectoryEntry>,
): { markdown: string; pageReferences: PageReferenceSpan[] } {
  const directory: ReadonlyMap<string, PageDirectoryEntry> = isPageDirectoryMap(pages)
    ? pages
    : new Map(pages.map((page) => [page.id, page]));
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
  return page.title || page.id;
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
  const stack = [...outline.blocks];
  while (stack.length > 0) {
    const block = stack.pop()!;
    if (block.id === blockId) return block;
    stack.push(...block.children);
  }
  return undefined;
}

export function findTag(snapshot: GraphSnapshot, tagId: string): TagSnapshot | undefined {
  return snapshot.tags.find((tag) => tag.id === tagId);
}
