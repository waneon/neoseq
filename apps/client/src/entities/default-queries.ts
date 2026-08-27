// Graph-owned standing questions. Canonical queries are read from GraphSession
// and changed through domain commands; this module only owns their bounded shape
// and execution identity.

import type {
  DefaultQuerySnapshot,
  PropertyDocument,
  QueryPlanDocument,
  QueryViewKind,
} from "../core-port/snapshot";
import { newQueryDocument } from "./query-document";

export type DefaultQuery = DefaultQuerySnapshot;

export const MAX_DEFAULT_QUERIES = 8;
export const MAX_DEFAULT_QUERY_TITLE = 80;
/** The canonical document a newly-created standing question owns. */
export function newDefaultQueryDocument(
  source: string,
  plan: QueryPlanDocument | undefined,
  layout: QueryViewKind,
): PropertyDocument {
  return newQueryDocument(source, plan ?? null, layout);
}

export function defaultQueryDocument(query: DefaultQuery): PropertyDocument {
  return query.document;
}

export function defaultQueryKey(query: DefaultQuery): string {
  return JSON.stringify(["default-query", query.id]);
}
