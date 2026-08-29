// What a query *says*, in the vocabulary the product already uses.
//
// SPARQL is the executable artifact; a plan is the authoring representation the
// builder writes it from, and it is stored beside the source so reopening a
// query reopens the builder. Everything here is pure data plus the rules that
// decide which operators a field admits — no React, no session, no SPARQL.
// `query-compile.ts` turns a plan into source and run-time parameters.

import type { GraphSnapshot, PropertyValueType } from "../core-port/snapshot";
import { FAVOURITE_ORDER_KEY } from "./favourites";
import {
  cardinalityOf,
  isGenericProperty,
  REGISTRY,
  stringChoicesOf,
  valueTypeOf,
} from "./properties";

export const QUERY_PLAN_VERSION = 1;

/** What the query looks for. Each answer is one `rdf:type` in the projection. */
export type PlanSubject = "block" | "page" | "tag";

export const PLAN_SUBJECTS: PlanSubject[] = ["block", "page", "tag"];

/**
 * Where a condition or column reads from. `content` is the subject's own text —
 * a block's Markdown, a page's title, a tag's name — because that is the one
 * field every subject has.
 */
export type PlanField =
  | { kind: "content" }
  | { kind: "property"; key: string }
  | { kind: "tag" }
  | { kind: "page" }
  | { kind: "ancestor" }
  | { kind: "sibling_index" };

export type PlanFieldKind = PlanField["kind"];

/** Stable identity shared by the condition picker and canonical list ordering. */
export type QueryFieldId = Exclude<PlanFieldKind, "property"> | `property:${string}`;

export type PlanOperator =
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "equals"
  | "not_equals"
  | "any_of"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "is_true"
  | "is_false"
  | "is_set"
  | "is_empty";

/**
 * A relative day, resolved against the reader's own today every time the query
 * runs. Storing the offset rather than the date is what makes “due this week”
 * still mean this week next week.
 */
export interface PlanRelativeDate {
  unit: "day" | "week" | "month";
  offset: number;
}

export type PlanScalar =
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "date"; value: string }
  | { type: "relative"; value: PlanRelativeDate }
  | { type: "page"; value: string }
  | { type: "tag"; value: string };

/** `list` is the operand of `is any of`; it expands into one scalar per member. */
export type PlanValue = PlanScalar | { type: "list"; values: string[] };

export interface PlanCondition {
  id: string;
  kind: "condition";
  field: PlanField;
  op: PlanOperator;
  value?: PlanValue;
  /** The upper bound of `between`. */
  value2?: PlanValue;
}

/** `all` is AND, `any` is OR, `none` is “not one of these”. */
export type PlanMatch = "all" | "any" | "none";

export interface PlanGroup {
  id: string;
  kind: "group";
  match: PlanMatch;
  children: PlanNode[];
}

export type PlanNode = PlanCondition | PlanGroup;

export type PlanColumnSource =
  | { kind: "subject" }
  | { kind: "content" }
  | { kind: "page" }
  | { kind: "property"; key: string }
  | { kind: "tags" }
  | { kind: "parent" }
  | { kind: "sibling_index" };

export type PlanAggregate = "list" | "count" | "sum" | "avg" | "min" | "max";

export interface PlanColumn {
  id: string;
  source: PlanColumnSource;
  /** A name the user typed. Absent means “call it what the product calls it”. */
  label?: string;
  aggregate?: PlanAggregate;
}

export interface QueryPlan {
  version: number;
  subject: PlanSubject;
  where: PlanGroup;
  columns: PlanColumn[];
  limit: number;
  distinct: boolean;
}

export const PLAN_LIMIT_MAX = 1000;
export const PLAN_ANY_OF_MAX = 32;
export const PLAN_MAX_CONDITIONS = 64;
export const PLAN_MAX_DEPTH = 4;

let sequence = 0;

/** Ids only have to be unique inside one plan, and stable while it is edited. */
function planId(prefix: string): string {
  sequence += 1;
  return `${prefix}${sequence.toString(36)}`;
}

export function emptyGroup(match: PlanMatch = "all"): PlanGroup {
  return { id: planId("g"), kind: "group", match, children: [] };
}

/**
 * The query a `/` command creates: every one of them, showing the one thing they
 * all have. It runs immediately, so the builder opens on a result rather than on
 * an empty frame.
 *
 * There is deliberately no identity column. Which thing a row *is* travels
 * beside the columns (the compiler always selects the subject), and the text
 * column is the route to it — a column of block ids would be a column nobody
 * reads.
 */
export function defaultPlan(subject: PlanSubject = "block"): QueryPlan {
  const columns: PlanColumn[] = [{ id: "text", source: { kind: "content" } }];
  if (subject === "block") columns.push({ id: "page", source: { kind: "page" } });
  return {
    version: QUERY_PLAN_VERSION,
    subject,
    where: emptyGroup("all"),
    columns,
    limit: 100,
    distinct: false,
  };
}

/**
 * The query a tag opens on: everything the tag names, most recent structure
 * first. It is a plan like any other — seeded, not fixed — so a reader who wants
 * the pages carrying the tag rather than its blocks edits the same builder every
 * other query uses instead of asking for a second kind of query.
 */
export function tagPlan(tagId: string): QueryPlan {
  return {
    ...defaultPlan("block"),
    where: {
      id: planId("g"),
      kind: "group",
      match: "all",
      children: [
        {
          id: planId("c"),
          kind: "condition",
          field: { kind: "tag" },
          op: "equals",
          value: { type: "tag", value: tagId },
        },
      ],
    },
  };
}

// ── Field typing ──────────────────────────────────────────────────────────────

/**
 * The value kind a field holds, which is what decides its operators and its
 * editor. Unknown property keys are text until the graph says otherwise.
 */
export type PlanFieldType = PropertyValueType | "tag" | "integer";

export function fieldType(field: PlanField): PlanFieldType {
  switch (field.kind) {
    case "content":
      return "string";
    case "tag":
      return "tag";
    case "page":
    case "ancestor":
      return "page";
    case "sibling_index":
      return "integer";
    case "property":
      return valueTypeOf(field.key) ?? "string";
  }
}

const TEXT_OPERATORS: PlanOperator[] = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "starts_with",
  "ends_with",
  "any_of",
  "is_set",
  "is_empty",
];
const NUMBER_OPERATORS: PlanOperator[] = [
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "is_set",
  "is_empty",
];
const DATE_OPERATORS: PlanOperator[] = [
  "equals",
  "not_equals",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "is_set",
  "is_empty",
];
const CHOICE_OPERATORS: PlanOperator[] = ["equals", "not_equals", "any_of", "is_set", "is_empty"];
const REFERENCE_OPERATORS: PlanOperator[] = [
  "equals",
  "not_equals",
  "any_of",
  "is_set",
  "is_empty",
];
const CHECKBOX_OPERATORS: PlanOperator[] = ["is_true", "is_false", "is_set", "is_empty"];

export function operatorsFor(field: PlanField): PlanOperator[] {
  const type = fieldType(field);
  if (type === "checkbox") return CHECKBOX_OPERATORS;
  if (type === "number" || type === "integer") return NUMBER_OPERATORS;
  if (type === "date") return DATE_OPERATORS;
  if (type === "page" || type === "tag") return REFERENCE_OPERATORS;
  if (field.kind === "property" && stringChoicesOf(field.key).length > 0) return CHOICE_OPERATORS;
  return TEXT_OPERATORS;
}

/** Operators that stand alone: the field's presence *is* the whole condition. */
export function operatorTakesValue(op: PlanOperator): boolean {
  return op !== "is_set" && op !== "is_empty" && op !== "is_true" && op !== "is_false";
}

export function operatorTakesRange(op: PlanOperator): boolean {
  return op === "between";
}

export function operatorTakesList(op: PlanOperator): boolean {
  return op === "any_of";
}

/** Which fields a subject can be asked about. Hierarchy is a block's alone. */
export function fieldKindsFor(subject: PlanSubject): PlanFieldKind[] {
  if (subject === "block") {
    return ["content", "property", "tag", "page", "ancestor", "sibling_index"];
  }
  if (subject === "page") return ["content", "property", "tag"];
  return ["content", "property"];
}

/**
 * The complete condition vocabulary for one subject. List ordering consumes
 * this same catalog, so a field can never be filterable but absent from its sort
 * control merely because a table did not project it.
 */
export function queryFieldsFor(subject: PlanSubject, propertyKeys: readonly string[]): PlanField[] {
  return [
    ...fieldKindsFor(subject)
      .filter((kind) => kind !== "property")
      .map((kind) => ({ kind }) as PlanField),
    ...propertyKeys.map((key) => ({ kind: "property", key }) as PlanField),
  ];
}

export function queryFieldId(field: PlanField): QueryFieldId {
  return field.kind === "property" ? `property:${field.key}` : field.kind;
}

/**
 * A column source as one string — the identity a control toggles by, and the
 * only place the `property:` prefix is spelled. Two sources that name the same
 * field give the same key, which is what lets a panel of choices and a plan's
 * own columns be matched up without comparing objects.
 */
export function columnSourceKey(source: PlanColumnSource): string {
  return source.kind === "property" ? `property:${source.key}` : source.kind;
}

/**
 * Everything a subject could be asked to show, in the order a reader meets it:
 * its own fields first, then the graph's reader-facing vocabulary. Structural
 * bookkeeping and the private favourite order are query inputs, not useful
 * result columns.
 */
export function columnSourcesFor(
  subject: PlanSubject,
  propertyKeys: readonly string[],
): PlanColumnSource[] {
  const kinds = columnKindsFor(subject).filter((kind) => kind !== "property");
  return [
    ...kinds.map((kind) => ({ kind }) as PlanColumnSource),
    ...propertyKeys
      .filter((key) => key !== FAVOURITE_ORDER_KEY)
      .map((key) => ({ kind: "property", key }) as PlanColumnSource),
  ];
}

export function columnKindsFor(subject: PlanSubject): PlanColumnSource["kind"][] {
  if (subject === "block") {
    return ["content", "property", "tags", "page"];
  }
  if (subject === "page") return ["content", "property", "tags"];
  return ["content", "property"];
}

/** Whether the columns panel may offer or retain this source. */
export function isDisplayColumnSource(source: PlanColumnSource): boolean {
  if (source.kind === "subject" || source.kind === "parent" || source.kind === "sibling_index") {
    return false;
  }
  return source.kind !== "property" || source.key !== FAVOURITE_ORDER_KEY;
}

/** Property keys a plan may name: the graph's own writable, visible vocabulary. */
export function planPropertyKeys(present: Iterable<string> = []): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(REGISTRY)) {
    if (isGenericProperty(key) && valueTypeOf(key) !== "document") keys.add(key);
  }
  for (const key of present) if (isGenericProperty(key)) keys.add(key);
  return [...keys].sort();
}

/**
 * Every property key this graph actually uses, plus the registry's own — the
 * vocabulary both the condition rows and the column switches offer.
 *
 * It walks every block on the graph, and more than one surface asks for it on
 * the same snapshot: the builder while it is open, the columns panel beside it.
 * A snapshot is immutable, so one walk answers all of them, and the cache dies
 * with the revision that filled it.
 */
const propertyKeyCache = new WeakMap<GraphSnapshot, string[]>();

export function graphPropertyKeys(snapshot: GraphSnapshot): string[] {
  const cached = propertyKeyCache.get(snapshot);
  if (cached) return cached;
  const present = new Set<string>();
  const visit = (bag: { key: string }[]) => {
    for (const field of bag) if (isGenericProperty(field.key)) present.add(field.key);
  };
  for (const page of snapshot.pages) {
    visit(page.properties);
    const stack = [...page.blocks];
    while (stack.length > 0) {
      const block = stack.pop()!;
      visit(block.properties);
      stack.push(...block.children);
    }
  }
  for (const tag of snapshot.tags) {
    visit(tag.properties);
    visit(tag.defaults);
  }
  const keys = planPropertyKeys(present);
  propertyKeyCache.set(snapshot, keys);
  return keys;
}

/** A repeated relation yields a row per value unless the column folds them. */
function isMultiValued(source: PlanColumnSource): boolean {
  if (source.kind === "tags") return true;
  if (source.kind === "property") return cardinalityOf(source.key) === "repeated";
  return false;
}

/**
 * How a column arrives: folded when its relation repeats, otherwise as its own
 * value. Counting the subject remains here only to read plans from older peers;
 * it is no longer an offered display field.
 */
export function defaultAggregateFor(source: PlanColumnSource): PlanAggregate | undefined {
  if (source.kind === "subject") return "count";
  return isMultiValued(source) ? "list" : undefined;
}

/**
 * What a condition starts on. A date starts *relative* — “today”, not the day
 * the condition was written — because that is what a saved query almost always
 * means.
 */
export function defaultValueForField(field: PlanField): PlanValue {
  const type = fieldType(field);
  switch (type) {
    case "number":
    case "integer":
      return { type: "number", value: 0 };
    case "date":
      return { type: "relative", value: { unit: "day", offset: 0 } };
    case "page":
      return { type: "page", value: "" };
    case "tag":
      return { type: "tag", value: "" };
    default: {
      const choices = field.kind === "property" ? stringChoicesOf(field.key) : [];
      return { type: "text", value: choices[0] ?? "" };
    }
  }
}

// ── Structure edits ───────────────────────────────────────────────────────────

/** A new condition opens on the one field every subject has: its own text. */
export function newCondition(): PlanCondition {
  const field: PlanField = { kind: "content" };
  const op = operatorsFor(field)[0];
  return {
    id: planId("c"),
    kind: "condition",
    field,
    op,
    value: operatorTakesValue(op) ? defaultValueForField(field) : undefined,
  };
}

export function countConditions(node: PlanNode): number {
  if (node.kind === "condition") return 1;
  return node.children.reduce((total, child) => total + countConditions(child), 0);
}

export function groupDepth(node: PlanNode): number {
  if (node.kind === "condition") return 0;
  return 1 + node.children.reduce((deepest, child) => Math.max(deepest, groupDepth(child)), 0);
}

/** Replace one node inside the tree, returning a new tree. */
export function replaceNode(root: PlanGroup, id: string, next: PlanNode | null): PlanGroup {
  const children: PlanNode[] = [];
  for (const child of root.children) {
    if (child.id === id) {
      if (next) children.push(next);
      continue;
    }
    children.push(child.kind === "group" ? replaceNode(child, id, next) : child);
  }
  return { ...root, children };
}

export function appendNode(root: PlanGroup, groupId: string, node: PlanNode): PlanGroup {
  if (root.id === groupId) return { ...root, children: [...root.children, node] };
  return {
    ...root,
    children: root.children.map((child) =>
      child.kind === "group" ? appendNode(child, groupId, node) : child,
    ),
  };
}

/**
 * Column ids double as SPARQL variable names. `q_` is reserved for the
 * compiler's own scratch variables, so a column that would land there is moved
 * aside rather than shadowing one.
 */
export function columnVariable(column: PlanColumn): string {
  const cleaned = column.id.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z]/.test(cleaned) || cleaned.startsWith("q_")) return `c_${cleaned}`;
  return cleaned;
}

export function nextColumnId(plan: QueryPlan, base: string): string {
  const taken = new Set(plan.columns.map((column) => column.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

export function columnBaseId(source: PlanColumnSource): string {
  switch (source.kind) {
    case "subject":
      return "item";
    case "content":
      return "text";
    case "page":
      return "page";
    case "parent":
      return "parent";
    case "tags":
      return "tags";
    case "sibling_index":
      return "order";
    case "property":
      return source.key.split(".")[1]?.replace(/-/g, "_") ?? "value";
  }
}

// ── Column edits ──────────────────────────────────────────────────────────────

/**
 * The plan with one more column, named after its source. A relation with many
 * values folds into one cell by default; a row per tag would multiply the answer
 * rather than describe it.
 */
export function withColumn(plan: QueryPlan, source: PlanColumnSource): QueryPlan {
  return {
    ...plan,
    columns: [
      ...plan.columns,
      {
        id: nextColumnId(plan, columnBaseId(source)),
        source,
        aggregate: defaultAggregateFor(source),
      },
    ],
  };
}

/** The plan with one column gone. The last one standing is never dropped. */
export function withoutColumn(plan: QueryPlan, id: string): QueryPlan {
  if (plan.columns.length <= 1) return plan;
  return { ...plan, columns: plan.columns.filter((column) => column.id !== id) };
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function encodePlan(plan: QueryPlan): string {
  return JSON.stringify(plan);
}

/**
 * A plan is only usable when this build understands its version *and* its
 * shape. Anything else keeps the query on its SPARQL, which still runs.
 */
export function decodePlan(payload: string, version: number): QueryPlan | null {
  if (version !== QUERY_PLAN_VERSION) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!validPlan(parsed)) return null;
  // Stated field by field rather than spread, so a key this build no longer
  // knows is read once and then gone instead of riding along in every save.
  // Column modes used to be a reader choice. They now follow cardinality: a
  // repeated value is folded into one cell and every other value stays plain.
  const columns = parsed.columns
    .filter((column) => isDisplayColumnSource(column.source))
    .map((column) => {
      const aggregate = defaultAggregateFor(column.source);
      if (aggregate) return { ...column, aggregate };
      const { aggregate: _legacyAggregate, ...plain } = column;
      return plain;
    });
  return {
    version: QUERY_PLAN_VERSION,
    subject: parsed.subject,
    where: parsed.where,
    // An old plan may have contained only a structural or summary column. Text
    // is the one useful field every subject has, so it is the safe replacement.
    columns: columns.length > 0 ? columns : [{ id: "text", source: { kind: "content" } }],
    limit: parsed.limit,
    distinct: parsed.distinct === true,
  };
}

function validPlan(value: unknown): value is QueryPlan {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<QueryPlan>;
  if (!PLAN_SUBJECTS.includes(plan.subject as PlanSubject)) return false;
  if (!plan.where || !validNode(plan.where)) return false;
  if (!Array.isArray(plan.columns) || plan.columns.length === 0) return false;
  if (!plan.columns.every(validColumn)) return false;
  if (typeof plan.limit !== "number" || plan.limit < 1 || plan.limit > PLAN_LIMIT_MAX) return false;
  if (countConditions(plan.where) > PLAN_MAX_CONDITIONS) return false;
  if (groupDepth(plan.where) > PLAN_MAX_DEPTH) return false;
  return true;
}

function validNode(value: unknown): value is PlanNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as { kind?: string; id?: unknown };
  if (typeof node.id !== "string" || node.id.length === 0) return false;
  if (node.kind === "group") {
    const group = value as PlanGroup;
    return (
      ["all", "any", "none"].includes(group.match) &&
      Array.isArray(group.children) &&
      group.children.every(validNode)
    );
  }
  if (node.kind !== "condition") return false;
  const condition = value as PlanCondition;
  if (typeof condition.op !== "string") return false;
  if (typeof condition.field !== "object" || condition.field === null) return false;
  if (condition.field.kind === "property" && typeof condition.field.key !== "string") return false;
  return true;
}

function validColumn(value: unknown): value is PlanColumn {
  if (typeof value !== "object" || value === null) return false;
  const column = value as PlanColumn;
  if (typeof column.id !== "string" || column.id.length === 0) return false;
  if (typeof column.source !== "object" || column.source === null) return false;
  return true;
}
