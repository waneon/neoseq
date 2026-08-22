import type { RdfTerm } from "../../generated/core-port";
import type { QueryViewSort } from "../../core-port/snapshot";
import type { OrderSemantics } from "../../entities/query-ordering";
import {
  entityName,
  type CellContext,
  type ResultColumn,
  type ResultViewRow,
} from "./cells";

function fixedBucket(comparison: number, descending: boolean): number {
  // TanStack reverses the comparator for descending order. Bucket placement is
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
    const rank = (value: string) => value === "true" || value === "1" ? 1 : 0;
    return rank(left.value) - rank(right.value);
  }

  // ISO local dates compare chronologically as strings. Text and entity names
  // use the product's one locale-aware, numeric collator.
  if (semantics.kind === "date") {
    return left.value === right.value ? 0 : left.value < right.value ? -1 : 1;
  }
  return context.compare(
    textOf(left, semantics, context),
    textOf(right, semantics, context),
  );
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
      const comparison = compareResultTerms(
        left.values[sort.variable],
        right.values[sort.variable],
        column.ordering,
        context,
        sort.descending,
      );
      if (comparison !== 0) return sort.descending ? -comparison : comparison;
    }
    return 0;
  });
}
