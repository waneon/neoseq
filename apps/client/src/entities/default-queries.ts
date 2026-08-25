// Graph-owned standing questions. Canonical queries are read from GraphSession
// and changed through domain commands; this module only owns their bounded shape
// and execution identity.

import type {
  DefaultQuerySnapshot,
  PropertyDocument,
  QueryPlanDocument,
  QueryViewKind,
} from "../core-port/snapshot";
import { QUERY_LANGUAGE } from "./query-compile";

export type DefaultQuery = DefaultQuerySnapshot;

export const MAX_DEFAULT_QUERIES = 8;
export const MAX_DEFAULT_QUERY_TITLE = 80;
const VIEW_ID = "all";

/** The canonical document a newly-created standing question owns. */
export function newDefaultQueryDocument(
  source: string,
  plan: QueryPlanDocument | undefined,
  layout: QueryViewKind,
): PropertyDocument {
  return {
    schema: "neoseq.query",
    version: 2,
    views: [
      {
        id: VIEW_ID,
        name: "All",
        definition: { source, language: QUERY_LANGUAGE, plan: plan ?? null },
        kind: layout,
        position: 0,
        columns: [],
        options: { compact: false, wrap: false, sort: [], list_sort: [] },
      },
    ],
    default_view_id: VIEW_ID,
  };
}

export function defaultQueryDocument(query: DefaultQuery): PropertyDocument {
  return query.document;
}

export function defaultQueryKey(query: DefaultQuery): string {
  return JSON.stringify(["default-query", query.id]);
}
