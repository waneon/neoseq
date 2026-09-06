import type { QueryEntityRef, RdfTerm } from "../../generated/core-port";
import type { PropertyValue, QueryViewFieldSort, QueryViewSort } from "../../core-port/snapshot";
import type { OrderSemantics } from "../../entities/query-ordering";
import type { PlanField } from "../../entities/query-plan";
import { isTaskDateKey, isTimeOfDay, timeKeyFor } from "../../entities/tasks";
import { outlineIndex, type OutlineRow } from "../../core-port/outline-index";
import { findOutline } from "../../core-port/snapshot";
import { entityName, type CellContext, type ResultColumn, type ResultViewRow } from "./cells";

function fixedBucket(comparison: number, descending: boolean): number {
  // The row comparator reverses descending order. Bucket placement is
  // invariant, so pre-reverse it here: known values and bound values stay ahead
  // of fallbacks in either direction.
  return descending ? -comparison : comparison;
}

function textOf(term: RdfTerm, semantics: OrderSemantics, context: CellContext): string {
  if (semantics.kind === "entity_label" && term.kind === "iri" && term.entity) {
    return entityName(term.entity, context);
  }
  return term.value;
}

/**
 * An ascending term comparator. `descending` is needed only to pre-compensate
 * direction-invariant buckets; the row comparator below reverses the semantic
 * value comparison itself.
 */
export function compareResultTerms(
  left: RdfTerm | undefined,
  right: RdfTerm | undefined,
  semantics: OrderSemantics,
  context: CellContext,
  descending: boolean,
): number {
  if (semantics.kind === "ranked") {
    if (!left && !right) return 0;
    if (semantics.missing === "last" && (!left || !right)) {
      return fixedBucket(left ? -1 : 1, descending);
    }
    const leftRank = left ? semantics.values.indexOf(left.value) : -1;
    const rightRank = right ? semantics.values.indexOf(right.value) : -1;
    // For priority, absence participates in the rank below Low. An arbitrary
    // stored fallback is still outside the declared domain and stays last in
    // either direction.
    const leftFallback = Boolean(left) && leftRank < 0;
    const rightFallback = Boolean(right) && rightRank < 0;
    if (leftFallback !== rightFallback) {
      return fixedBucket(leftFallback ? 1 : -1, descending);
    }
    if (leftFallback && rightFallback) return context.compare(left!.value, right!.value);
    if (!left || !right) return left ? 1 : -1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return context.compare(left.value, right.value);
  }

  if (!left || !right) {
    if (!left && !right) return 0;
    return fixedBucket(left ? -1 : 1, descending);
  }

  if (semantics.kind === "number") {
    const leftNumber = Number(left.value);
    const rightNumber = Number(right.value);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
  }
  if (semantics.kind === "boolean") {
    const rank = (value: string) => (value === "true" || value === "1" ? 1 : 0);
    return rank(left.value) - rank(right.value);
  }

  // ISO local dates compare chronologically as strings. Text and entity names
  // use the product's one locale-aware, numeric collator.
  if (semantics.kind === "date") {
    return left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  }
  return context.compare(textOf(left, semantics, context), textOf(right, semantics, context));
}

/**
 * Apply one saved presentation order to a result before either renderer sees
 * it. Equal rows retain the query's order because modern Array sorting is
 * stable; unsupported or removed variables are ignored defensively.
 */
export function orderResultRows(
  rows: readonly ResultViewRow[],
  sorts: readonly QueryViewSort[],
  columns: readonly ResultColumn[],
  context: CellContext,
): ResultViewRow[] {
  if (sorts.length === 0 || rows.length < 2) return [...rows];
  const byVariable = new Map(columns.map((column) => [column.variable, column]));
  return [...rows].sort((left, right) => {
    for (const sort of sorts) {
      const column = byVariable.get(sort.variable);
      if (!column?.sortable) continue;
      const comparison = compareSortValues(
        {
          terms: left.values[sort.variable] ?? [],
          time: column.timeColumn ? left.values[column.timeColumn]?.[0] : undefined,
        },
        {
          terms: right.values[sort.variable] ?? [],
          time: column.timeColumn ? right.values[column.timeColumn]?.[0] : undefined,
        },
        column.ordering,
        context,
        sort.descending,
      );
      if (comparison !== 0) return sort.descending ? -comparison : comparison;
    }
    return 0;
  });
}

/** One filter field as the list sorter understands it. */
export interface ListSortField {
  id: string;
  field: PlanField;
  ordering: OrderSemantics;
}

const XSD = "http://www.w3.org/2001/XMLSchema#";

function entityTerm(entity: QueryEntityRef): RdfTerm {
  return { kind: "iri", value: entity.id, entity };
}

function literalTerm(value: string, datatype: string): RdfTerm {
  return { kind: "literal", value, datatype: `${XSD}${datatype}` };
}

function propertyTerm(value: PropertyValue): RdfTerm[] {
  switch (value.type) {
    case "number":
      return [literalTerm(String(value.value), "double")];
    case "string":
      return [literalTerm(value.value, "string")];
    case "page":
      return [entityTerm({ kind: "page", id: value.value })];
    case "checkbox":
      return [literalTerm(String(value.value), "boolean")];
    case "date":
      return [literalTerm(value.value, "date")];
    case "document":
    case "unsupported_document":
      return [];
  }
}

function fieldTerms(
  entity: Extract<QueryEntityRef, { kind: "block" }>,
  row: OutlineRow,
  field: PlanField,
): RdfTerm[] {
  switch (field.kind) {
    case "content":
      return [literalTerm(row.block.markdown, "string")];
    case "property": {
      const property = row.block.properties.find((candidate) => candidate.key === field.key);
      return property?.values.flatMap(propertyTerm) ?? [];
    }
    case "tag":
      return row.block.tags.map((id) => entityTerm({ kind: "tag", id }));
    case "page":
    case "ancestor":
      return entity.owner.kind === "page"
        ? [entityTerm({ kind: "page", id: entity.owner.id })]
        : [];
    case "sibling_index":
      return [literalTerm(String(row.index), "integer")];
  }
}

interface SortValue {
  terms: readonly RdfTerm[];
  time?: RdfTerm;
}

function validTime(term: RdfTerm | undefined): RdfTerm | undefined {
  return term?.kind === "literal" && isTimeOfDay(term.value) ? term : undefined;
}

function compareSortValues(
  { terms: left, time: leftTime }: SortValue,
  { terms: right, time: rightTime }: SortValue,
  semantics: OrderSemantics,
  context: CellContext,
  descending: boolean,
): number {
  if (left.length === 0 || right.length === 0) {
    return compareResultTerms(left[0], right[0], semantics, context, descending);
  }
  const compare = (a: RdfTerm, b: RdfTerm) => compareResultTerms(a, b, semantics, context, false);
  const leftValues = [...left].sort(compare);
  const rightValues = [...right].sort(compare);
  const shared = Math.min(leftValues.length, rightValues.length);
  for (let index = 0; index < shared; index += 1) {
    const comparison = compareResultTerms(
      leftValues[index],
      rightValues[index],
      semantics,
      context,
      descending,
    );
    if (comparison !== 0) return comparison;
  }
  const lengthComparison = leftValues.length - rightValues.length;
  if (lengthComparison !== 0) return lengthComparison;
  // A companion clock refines equal dates before the next saved sort term.
  // Missing or invalid clocks stay last within that day in either direction.
  return compareResultTerms(
    validTime(leftTime),
    validTime(rightTime),
    { kind: "text" },
    context,
    descending,
  );
}

/**
 * Order canonical block references by the same complete field vocabulary the
 * condition builder offers. Multi-valued fields compare as semantically sorted
 * vectors; a missing field keeps the existing direction-invariant bucket rule.
 */
export function orderBlockRows(
  rows: readonly ResultViewRow[],
  sorts: readonly QueryViewFieldSort[],
  fields: readonly ListSortField[],
  context: CellContext,
): ResultViewRow[] {
  if (sorts.length === 0 || rows.length < 2) return [...rows];
  const descriptors = new Map(fields.map((field) => [field.id, field]));
  const values = new Map<string, Map<string, SortValue>>();

  for (const result of rows) {
    const entity = result.subject;
    const rowValues = new Map<string, SortValue>();
    if (entity?.kind === "block") {
      const outline = findOutline(context.snapshot, entity.owner);
      const blockRow = outline && outlineIndex(outline.blocks).get(entity.id);
      if (blockRow) {
        for (const sort of sorts) {
          const descriptor = descriptors.get(sort.field);
          if (!descriptor) continue;
          const field = descriptor.field;
          const time =
            field.kind === "property" && isTaskDateKey(field.key)
              ? fieldTerms(entity, blockRow, { kind: "property", key: timeKeyFor(field.key) })[0]
              : undefined;
          rowValues.set(sort.field, { terms: fieldTerms(entity, blockRow, field), time });
        }
      }
    }
    values.set(result.key, rowValues);
  }

  return [...rows].sort((left, right) => {
    for (const sort of sorts) {
      const descriptor = descriptors.get(sort.field);
      if (!descriptor) continue;
      const comparison = compareSortValues(
        values.get(left.key)?.get(sort.field) ?? { terms: [] },
        values.get(right.key)?.get(sort.field) ?? { terms: [] },
        descriptor.ordering,
        context,
        sort.descending,
      );
      if (comparison !== 0) return sort.descending ? -comparison : comparison;
    }
    return left.key === right.key ? 0 : left.key < right.key ? -1 : 1;
  });
}
