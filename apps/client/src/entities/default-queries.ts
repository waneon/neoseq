// Graph-owned standing questions and the one-way bridge from the browser-local
// shape older clients wrote. Canonical queries are read from GraphSession and
// changed through domain commands; this module only owns their bounded shape,
// execution identity, and legacy decoding.

import type {
  DefaultQuerySnapshot,
  PropertyDocument,
  QueryPlanDocument,
  QueryViewKind,
} from "../core-port/snapshot";
import { QUERY_LANGUAGE } from "./query-compile";
import { QUERY_PLAN_VERSION } from "./query-plan";
import { appSettings, updateAppSettings } from "./settings";

export type DefaultQuery = DefaultQuerySnapshot;

export interface LegacyDefaultQuery {
  id: string;
  title: string;
  /** The SPARQL that runs, compiled from `plan`. */
  source: string;
  /**
   * The builder's plan — the only thing Settings writes. Absent only for a
   * question stored by a build that still had a SPARQL editor: it runs and reads
   * exactly as the graph's own plan-less documents do, and has no editor either.
   */
  plan?: QueryPlanDocument;
  layout: QueryViewKind;
}

export const MAX_DEFAULT_QUERIES = 8;
export const MAX_DEFAULT_QUERY_TITLE = 80;
const VIEW_ID = "all";

/** The canonical document a newly-created or imported standing question owns. */
export function newDefaultQueryDocument(
  source: string,
  plan: QueryPlanDocument | undefined,
  layout: QueryViewKind,
): PropertyDocument {
  return {
    schema: "neoseq.query",
    version: 1,
    source,
    language: QUERY_LANGUAGE,
    views: [
      {
        id: VIEW_ID,
        name: "All",
        kind: layout,
        position: 0,
        columns: [],
        options: { compact: false, wrap: false, sort: [] },
      },
    ],
    default_view_id: VIEW_ID,
    plan: plan ?? null,
  };
}

export function defaultQueryDocument(query: DefaultQuery): PropertyDocument {
  return query.document;
}

export function defaultQueryKey(query: DefaultQuery): string {
  return JSON.stringify(["default-query", query.id]);
}

/**
 * Stable graph identity for one legacy slot. If its graph command applied but
 * persistence needs a retry, the next render can recognize the same import
 * instead of creating a duplicate.
 */
export function legacyDefaultQueryId(query: LegacyDefaultQuery, index: number): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify([query.id, index]))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `dq-legacy-${hash.toString(16).padStart(16, "0")}`;
}

/** Browser-local questions written by pre-v4 clients, offered for explicit import. */
export function legacyDefaultQueries(): LegacyDefaultQuery[] {
  const stored = appSettings().defaultQueries;
  if (!Array.isArray(stored)) return [];
  return stored
    .flatMap((entry) => {
      const repaired = repairLegacy(entry);
      return repaired ? [repaired] : [];
    })
    .slice(0, MAX_DEFAULT_QUERIES);
}

/** Called only after every imported query has been durably saved in the graph. */
export function clearLegacyDefaultQueries(): void {
  updateAppSettings({ defaultQueries: undefined });
}

function repairLegacy(value: unknown): LegacyDefaultQuery | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.source !== "string") return null;
  const plan = repairPlan(record.plan);
  return {
    id: record.id,
    title:
      typeof record.title === "string"
        ? record.title.slice(0, MAX_DEFAULT_QUERY_TITLE)
        : "",
    source: record.source,
    ...(plan ? { plan } : {}),
    layout: record.layout === "table" ? "table" : "list",
  };
}

function repairPlan(value: unknown): QueryPlanDocument | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== QUERY_PLAN_VERSION) return undefined;
  return typeof record.payload === "string"
    ? { version: QUERY_PLAN_VERSION, payload: record.payload }
    : undefined;
}
