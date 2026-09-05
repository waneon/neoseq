// UI metadata for typed query plans.
//
// Plan semantics deliberately do not live here. Rust is the sole compiler from
// QueryPlan to logical algebra and the sole producer of compatibility SPARQL.

import { QUERY_PLAN_SOURCE_PROVENANCE } from "../generated/core-port";

export { QUERY_LANGUAGE } from "./query-document";

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
