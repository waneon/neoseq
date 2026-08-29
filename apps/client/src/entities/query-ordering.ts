// The semantic order of a query column.
//
// Rendering and ordering are different projections of the same value. A task
// priority may render as `Low`, `낮음`, or a glyph, but its order is the rank of
// the stored `low` value. This module keeps that meaning in pure data, one
// contract away from the comparator that consumes it — so a column's order is
// the same fact whichever renderer is reading it, and a translated label can
// never move a row.

import type { RdfTerm } from "../generated/core-port";
import { orderingOf, stringChoicesOf, valueTypeOf } from "./properties";
import type { PlanColumn, PlanColumnSource, PlanField } from "./query-plan";
import { TASK_PRIORITY_KEY } from "./tasks";

export type OrderSemantics =
  | { kind: "ranked"; values: readonly string[]; missing: "below" | "last" }
  | { kind: "number" }
  | { kind: "date" }
  | { kind: "boolean" }
  | { kind: "text" }
  | { kind: "entity_label" }
  /** A folded collection has no defined member order in the query profile. */
  | { kind: "unsupported_list" };

function propertyOrderSemantics(key: string): OrderSemantics {
  if (orderingOf(key)?.kind === "choice_order") {
    return {
      kind: "ranked",
      values: stringChoicesOf(key),
      // No priority is weaker than Low. Other ranked fields keep absence
      // outside the declared progression, after open-choice fallbacks.
      missing: key === TASK_PRIORITY_KEY ? "below" : "last",
    };
  }
  switch (valueTypeOf(key)) {
    case "number":
      return { kind: "number" };
    case "date":
      return { kind: "date" };
    case "checkbox":
      return { kind: "boolean" };
    case "page":
      return { kind: "entity_label" };
    default:
      return { kind: "text" };
  }
}

function sourceOrderSemantics(source: PlanColumnSource): OrderSemantics {
  switch (source.kind) {
    case "sibling_index":
      return { kind: "number" };
    case "page":
    case "parent":
    case "subject":
      return { kind: "entity_label" };
    case "property":
      return propertyOrderSemantics(source.key);
    default:
      return { kind: "text" };
  }
}

/** The semantic order of a condition field when a canonical entity list uses it. */
export function orderSemanticsForField(field: PlanField): OrderSemantics {
  switch (field.kind) {
    case "sibling_index":
      return { kind: "number" };
    case "tag":
    case "page":
    case "ancestor":
      return { kind: "entity_label" };
    case "property":
      return propertyOrderSemantics(field.key);
    case "content":
      return { kind: "text" };
  }
}

export function orderSemanticsForColumn(
  column: Pick<PlanColumn, "source" | "aggregate">,
): OrderSemantics {
  switch (column.aggregate) {
    case "count":
    case "sum":
    case "avg":
      return { kind: "number" };
    case "list":
      return { kind: "unsupported_list" };
    default:
      return sourceOrderSemantics(column.source);
  }
}

const NUMERIC_DATATYPE = /#(?:double|decimal|integer|float|long|int)$/u;
const DATE_DATATYPE = /#date$/u;
const BOOLEAN_DATATYPE = /#boolean$/u;

/** Best-effort semantics for a hand-written SPARQL column with no plan provenance. */
export function inferOrderSemantics(terms: Iterable<RdfTerm | undefined>): OrderSemantics {
  const bound = [...terms].filter((term): term is RdfTerm => term !== undefined);
  if (bound.length === 0) return { kind: "text" };
  if (bound.every((term) => term.kind === "iri")) return { kind: "entity_label" };
  if (bound.every((term) => term.kind === "literal" && NUMERIC_DATATYPE.test(term.datatype))) {
    return { kind: "number" };
  }
  if (bound.every((term) => term.kind === "literal" && DATE_DATATYPE.test(term.datatype))) {
    return { kind: "date" };
  }
  if (bound.every((term) => term.kind === "literal" && BOOLEAN_DATATYPE.test(term.datatype))) {
    return { kind: "boolean" };
  }
  return { kind: "text" };
}
