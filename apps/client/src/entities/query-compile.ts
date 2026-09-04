// UI metadata for typed query plans.
//
// Plan semantics deliberately do not live here. Rust is the sole compiler from
// QueryPlan to logical algebra and the sole producer of compatibility SPARQL.

import { isTaskDateKey } from "./tasks";
import { columnVariable, type QueryPlan } from "./query-plan";
import { QUERY_PLAN_SOURCE_PROVENANCE } from "../generated/core-port";

export { QUERY_LANGUAGE } from "./query-document";

/** What a list-valued result cell uses between members. */
export const LIST_SEPARATOR = "\u001F";

/** The stable variable under which Rust returns an ungrouped plan's subject. */
export const SUBJECT_VARIABLE = "q_subject";

/** Variables in `q_` are compiler-owned and never user-authored columns. */
export function isCompilerVariable(variable: string): boolean {
  return variable.startsWith("q_");
}

/** The hidden time-of-day companion for a task date result column. */
export function momentTimeVariable(variable: string): string {
  return `q_time_${variable}`;
}

export interface PlanProjection {
  variables: string[];
  subjectVariable: string | null;
}

/**
 * Projection names are presentation metadata, not query compilation. They let
 * the table lay itself out before the first answer arrives while Rust owns every
 * join, filter, aggregate, ordering, and operand interpretation.
 */
export function planProjection(
  plan: QueryPlan,
  projection: "view" | "entities" = "view",
): PlanProjection {
  const columns = projection === "entities" ? [] : plan.columns;
  const aggregated = columns.some((column) => column.aggregate !== undefined);
  const variables: string[] = [];
  for (const column of columns) {
    const variable = columnVariable(column);
    variables.push(variable);
    if (
      column.aggregate === undefined &&
      column.source.kind === "property" &&
      isTaskDateKey(column.source.key)
    ) {
      variables.push(momentTimeVariable(variable));
    }
  }
  if (!aggregated) variables.unshift(SUBJECT_VARIABLE);
  return { variables, subjectVariable: aggregated ? null : SUBJECT_VARIABLE };
}

export const DERIVED_SOURCE_PROVENANCE = QUERY_PLAN_SOURCE_PROVENANCE;

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Provenance only; the Rust core supplies the SPARQL body. */
export function derivedSourceMarker(plan: { version: number; payload: string }): string {
  return `${DERIVED_SOURCE_PROVENANCE}${plan.version};fnv1a32=${fnv1a32(plan.payload)}\n`;
}

export type DerivedSourceProvenance = "current" | "legacy_unmarked" | "stale";

/** Detects migration state without reimplementing the Rust compiler. */
export function derivedSourceProvenance(
  storedSource: string,
  plan: { version: number; payload: string },
): DerivedSourceProvenance {
  if (storedSource.startsWith(derivedSourceMarker(plan))) return "current";
  if (!storedSource.startsWith(DERIVED_SOURCE_PROVENANCE)) return "legacy_unmarked";
  return "stale";
}
