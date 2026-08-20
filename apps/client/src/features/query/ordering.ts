import type { RdfTerm } from "../../generated/core-port";
import type { OrderSemantics } from "../../entities/query-ordering";
import { entityName, type CellContext } from "./cells";

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
 * An ascending comparator for TanStack's row model. `descending` is needed only
 * for direction-invariant buckets; the row model itself reverses the semantic
 * value comparison.
 */
export function compareResultTerms(
  left: RdfTerm | undefined,
  right: RdfTerm | undefined,
  semantics: OrderSemantics,
  context: CellContext,
  descending: boolean,
): number {
  if (!left || !right) {
    if (!left && !right) return 0;
    return fixedBucket(left ? -1 : 1, descending);
  }

  if (semantics.kind === "ranked") {
    const leftRank = semantics.values.indexOf(left.value);
    const rightRank = semantics.values.indexOf(right.value);
    const leftKnown = leftRank >= 0;
    const rightKnown = rightRank >= 0;
    if (leftKnown !== rightKnown) {
      return fixedBucket(leftKnown ? -1 : 1, descending);
    }
    if (leftKnown && rightKnown && leftRank !== rightRank) return leftRank - rightRank;
    return context.compare(left.value, right.value);
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
