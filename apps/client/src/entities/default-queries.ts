// The standing questions a reader keeps at the foot of today's journal.
//
// A default query is a *reading habit*, not graph content. "What is scheduled",
// "what did I leave unfinished" are questions about the reader's own day: they
// hold across every graph that person opens, nothing in a graph changes when one
// is added, and a collaborator has no business receiving them. So they live
// beside the other browser-local preferences, and the graph they run against
// never learns they exist.
//
// One is written in Settings and read in the journal, which is the only decision
// this module makes. What it hands the journal is an ordinary
// `neoseq.query` document — the same shape a page, block, or tag stores — so the
// surface that renders the answer cannot tell a default query from any other one
// and does not have to. What it cannot hand over is an owner: there is no entity
// to write to, which is exactly why the journal reads and Settings writes.

import type {
  PropertyDocument,
  QueryPlanDocument,
  QueryViewKind,
} from "../core-port/snapshot";
import { QUERY_LANGUAGE } from "./query-compile";
import { QUERY_PLAN_VERSION } from "./query-plan";
import { appSettings, updateAppSettings } from "./settings";

export interface DefaultQuery {
  id: string;
  /** What the reader calls it. Blank falls back to the question itself. */
  title: string;
  /** The SPARQL that runs: compiled from `plan`, or written by hand. */
  source: string;
  /** The builder's plan. Absent for hand-written SPARQL, as in the graph. */
  plan?: QueryPlanDocument;
  /** Which of the two renderers the journal reads the answer through. */
  layout: QueryViewKind;
}

/**
 * How many a day may carry. The foot of a journal is a place to glance at, and
 * a ninth standing question is a page of its own wearing a journal's clothes.
 */
export const MAX_DEFAULT_QUERIES = 8;

/** A caption is a phrase, and a phrase that outgrows its line is not one. */
export const MAX_DEFAULT_QUERY_TITLE = 80;

/** The single view a default query is read through; its layout is the setting. */
const VIEW_ID = "all";

export function defaultQueries(): DefaultQuery[] {
  const stored = appSettings().defaultQueries;
  if (!Array.isArray(stored)) return [];
  return stored
    .flatMap((entry) => {
      const repaired = repair(entry);
      return repaired ? [repaired] : [];
    })
    .slice(0, MAX_DEFAULT_QUERIES);
}

/** Replaces one in place. An id the list does not hold is left unwritten. */
export function putDefaultQuery(query: DefaultQuery): void {
  const current = defaultQueries();
  if (!current.some((entry) => entry.id === query.id)) return;
  write(current.map((entry) => (entry.id === query.id ? query : entry)));
}

/** Appends one and returns it, so the caller can open what it just made. */
export function addDefaultQuery(query: Omit<DefaultQuery, "id">): DefaultQuery | null {
  const current = defaultQueries();
  if (current.length >= MAX_DEFAULT_QUERIES) return null;
  const created = { ...query, id: `dq-${crypto.randomUUID()}` };
  write([...current, created]);
  return created;
}

export function removeDefaultQuery(id: string): void {
  write(defaultQueries().filter((entry) => entry.id !== id));
}

/** One step, expressed as the whole order — the same move a view strip makes. */
export function moveDefaultQuery(id: string, delta: -1 | 1): void {
  const current = defaultQueries();
  const index = current.findIndex((entry) => entry.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= current.length) return;
  const next = [...current];
  [next[index], next[target]] = [next[target], next[index]];
  write(next);
}

/**
 * The document the query surface reads. Its view carries the reader's layout
 * because that is the one presentation choice they cannot make from the journal:
 * there is no document there to write it into.
 */
export function defaultQueryDocument(query: DefaultQuery): PropertyDocument {
  return {
    schema: "neoseq.query",
    version: 1,
    source: query.source,
    language: QUERY_LANGUAGE,
    views: [
      {
        id: VIEW_ID,
        name: "All",
        kind: query.layout,
        position: 0,
        columns: [],
        options: { compact: false, wrap: false, sort: [] },
      },
    ],
    default_view_id: VIEW_ID,
    plan: query.plan ?? null,
  };
}

/**
 * One cached answer per default query, shared by the journal that reads it and
 * the editor that wrote it: the same question asked twice is one execution, and
 * the count in Settings is the count under the journal.
 */
export function defaultQueryKey(query: DefaultQuery): string {
  return JSON.stringify(["default-query", query.id]);
}

function write(queries: DefaultQuery[]): void {
  updateAppSettings({ defaultQueries: queries.length > 0 ? queries : undefined });
}

/**
 * A stored entry, read into a usable one. A default query renders on every
 * journal visit, so a partial or foreign record must cost the record and not the
 * day: anything without an id and a source is dropped, and everything else takes
 * its default.
 */
function repair(value: unknown): DefaultQuery | null {
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

/**
 * A plan this build does not understand leaves the query on its source, which
 * still runs — the same reading the graph's own documents get.
 */
function repairPlan(value: unknown): QueryPlanDocument | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== QUERY_PLAN_VERSION) return undefined;
  return typeof record.payload === "string"
    ? { version: QUERY_PLAN_VERSION, payload: record.payload }
    : undefined;
}
