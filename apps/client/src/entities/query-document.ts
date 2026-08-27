import type {
  PropertyDocument,
  QueryPlanDocument,
  QueryView,
  QueryViewKind,
} from "../core-port/snapshot";

export const QUERY_DOCUMENT_SCHEMA = "neoseq.query";
export const QUERY_DOCUMENT_VERSION = 2;
export const INITIAL_QUERY_VIEW_ID = "all";
export const QUERY_LANGUAGE = "sparql-1.1/neoseq-v1" as const;

export function initialQueryView(
  source: string,
  plan: QueryPlanDocument | null = null,
  kind: QueryViewKind = "table",
): QueryView {
  return {
    id: INITIAL_QUERY_VIEW_ID,
    name: "All",
    definition: { source, language: QUERY_LANGUAGE, plan },
    kind,
    position: 0,
    columns: [],
    options: { compact: false, wrap: false, sort: [], list_sort: [] },
  };
}

/** The single canonical shape from which every new query document begins. */
export function newQueryDocument(
  source = "",
  plan: QueryPlanDocument | null = null,
  kind: QueryViewKind = "table",
): PropertyDocument {
  return {
    schema: QUERY_DOCUMENT_SCHEMA,
    version: QUERY_DOCUMENT_VERSION,
    views: [initialQueryView(source, plan, kind)],
    default_view_id: INITIAL_QUERY_VIEW_ID,
  };
}
