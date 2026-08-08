// Immutable DTO shapes produced by the Rust core (`domain::GraphSnapshot`).
// The UI renders these views and never mutates them locally.

export type PropertyValueType = "number" | "string" | "page" | "checkbox" | "date";

export type PropertyValue =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "page"; value: string }
  | { type: "checkbox"; value: boolean }
  | { type: "date"; value: string };

export interface PropertyEntry {
  key: string;
  value: PropertyValue;
}

export interface BlockSnapshot {
  id: string;
  markdown: string;
  properties: PropertyEntry[];
  tags: string[];
  children: BlockSnapshot[];
}

export interface PageSnapshot {
  id: string;
  title: string;
  properties: PropertyEntry[];
  tags: string[];
  blocks: BlockSnapshot[];
}

export interface PageSummary {
  id: string;
  title: string;
  properties: PropertyEntry[];
  tags: string[];
}

export interface TagSnapshot {
  id: string;
  name: string;
  properties: PropertyEntry[];
  defaults: PropertyEntry[];
}

export interface GraphSummary {
  schema_version: number;
  graph_id: string;
  pages: PageSummary[];
  tags: TagSnapshot[];
  quarantined: string[];
}

export interface GraphSnapshot {
  schema_version: number;
  graph_id: string;
  pages: PageSnapshot[];
  tags: TagSnapshot[];
  quarantined: string[];
}

export const EMPTY_SNAPSHOT: GraphSnapshot = {
  schema_version: 1,
  graph_id: "",
  pages: [],
  tags: [],
  quarantined: [],
};

export function mergeSummary(summary: GraphSummary, current: GraphSnapshot = EMPTY_SNAPSHOT): GraphSnapshot {
  const hydrated = new Map(current.pages.map((page) => [page.id, page.blocks]));
  return {
    ...summary,
    pages: summary.pages.map((page) => ({ ...page, blocks: hydrated.get(page.id) ?? [] })),
  };
}

export function mergePage(snapshot: GraphSnapshot, page: PageSnapshot): GraphSnapshot {
  return {
    ...snapshot,
    pages: snapshot.pages.map((current) => (current.id === page.id ? page : current)),
  };
}

export function singleValue(bag: PropertyEntry[], key: string): PropertyValue | undefined {
  return bag.find((entry) => entry.key === key)?.value;
}

export function stringValue(bag: PropertyEntry[], key: string): string | undefined {
  const value = singleValue(bag, key);
  return value?.type === "string" ? value.value : undefined;
}

export function dateValue(bag: PropertyEntry[], key: string): string | undefined {
  const value = singleValue(bag, key);
  return value?.type === "date" ? value.value : undefined;
}

export function repeatedValues(bag: PropertyEntry[], key: string): PropertyValue[] {
  return bag.filter((entry) => entry.key === key).map((entry) => entry.value);
}

export function pageTitle(page: PageSnapshot): string {
  return page.title || page.id;
}

export function pageKind(page: PageSnapshot): "regular" | "journal" {
  return stringValue(page.properties, "page.kind") === "journal" ? "journal" : "regular";
}

export function journalDate(page: PageSnapshot): string | undefined {
  return dateValue(page.properties, "journal.date");
}

export function isDeleted(page: PageSnapshot): boolean {
  return singleValue(page.properties, "system.deleted-at") !== undefined;
}

export function findPage(snapshot: GraphSnapshot, pageId: string): PageSnapshot | undefined {
  return snapshot.pages.find((page) => page.id === pageId);
}

export function findJournalPage(snapshot: GraphSnapshot, date: string): PageSnapshot | undefined {
  return snapshot.pages.find(
    (page) => pageKind(page) === "journal" && journalDate(page) === date,
  );
}

export function findBlock(page: PageSnapshot, blockId: string): BlockSnapshot | undefined {
  const stack = [...page.blocks];
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
