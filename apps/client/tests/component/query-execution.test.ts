import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSession } from "../../src/core-port/session";
import type {
  SparqlQueryRequest,
  SparqlQueryResult,
} from "../../src/generated/core-port";
import {
  QueryExecutionStore,
  queryExecutionSignature,
} from "../../src/features/query/execution";
import {
  queryEditorIsOpen,
  queryResultsAreOpen,
  rememberQueryEditorOpen,
  rememberQueryResultsOpen,
  resetQueryDisclosure,
} from "../../src/features/query/presentation";

const REQUEST_A: SparqlQueryRequest = {
  language: "sparql-1.1/neoseq-v1",
  source: "ASK { ?a ?b ?c }",
  bindings: {},
};
const REQUEST_B: SparqlQueryRequest = {
  language: "sparql-1.1/neoseq-v1",
  source: "ASK { ?x ?y ?z }",
  bindings: {},
};
const RESULT_TRUE: SparqlQueryResult = {
  kind: "ask",
  value: true,
  revision: 1,
  frontier: "one",
};
const RESULT_FALSE: SparqlQueryResult = {
  kind: "ask",
  value: false,
  revision: 1,
  frontier: "one",
};

describe("query execution store", () => {
  it("deduplicates an activation and reuses its fresh answer", async () => {
    const pending = deferred<SparqlQueryResult>();
    const query = vi.fn(() => pending.promise);
    const store = new QueryExecutionStore({ query } as unknown as GraphSession);
    const signature = queryExecutionSignature(REQUEST_A);

    const first = store.run("home:block", signature, 1, REQUEST_A);
    const duplicate = store.run("home:block", signature, 1, REQUEST_A);
    expect(query).toHaveBeenCalledTimes(1);
    expect(store.snapshot("home:block", signature, 1).loading).toBe(true);

    pending.resolve(RESULT_TRUE);
    await Promise.all([first, duplicate]);
    expect(store.snapshot("home:block", signature, 1)).toMatchObject({
      result: RESULT_TRUE,
      error: null,
      loading: false,
    });

    await store.run("home:block", signature, 1, REQUEST_A);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not let superseded work replace a cache hit", async () => {
    const pendingB = deferred<SparqlQueryResult>();
    const query = vi.fn((request: SparqlQueryRequest) =>
      request.source === REQUEST_A.source
        ? Promise.resolve(RESULT_TRUE)
        : pendingB.promise);
    const store = new QueryExecutionStore({ query } as unknown as GraphSession);
    const signatureA = queryExecutionSignature(REQUEST_A);
    const signatureB = queryExecutionSignature(REQUEST_B);

    await store.run("home:block", signatureA, 1, REQUEST_A);
    const obsolete = store.run("home:block", signatureB, 1, REQUEST_B);
    await store.run("home:block", signatureA, 1, REQUEST_A);

    pendingB.resolve(RESULT_FALSE);
    await obsolete;
    expect(store.snapshot("home:block", signatureA, 1).result).toEqual(RESULT_TRUE);
  });
});

describe("query disclosure", () => {
  beforeEach(resetQueryDisclosure);
  afterEach(resetQueryDisclosure);

  it("remembers a fold past the visit that made it, per graph and per query", () => {
    expect(queryResultsAreOpen("one", "home:block")).toBe(true);

    // Nothing is cached between the two calls, so this is the same question a
    // reload asks — and a reader who folded an answer must not have to fold it
    // a second time to make the same point.
    rememberQueryResultsOpen("one", "home:block", false);
    expect(queryResultsAreOpen("one", "home:block")).toBe(false);
    // Folding one answer says nothing about another answer, or about the same
    // query in a different graph.
    expect(queryResultsAreOpen("one", "home:other")).toBe(true);
    expect(queryResultsAreOpen("two", "home:block")).toBe(true);

    rememberQueryResultsOpen("one", "home:block", true);
    expect(queryResultsAreOpen("one", "home:block")).toBe(true);
    // Nothing folded is nothing stored.
    expect(localStorage.getItem("neoseq.query-disclosure.v1")).toBeNull();
  });

  it("remembers an opened question the same way, per graph and per query", () => {
    // Unpressed, the surface's own answer stands: shut over a query that reads,
    // open over one with nothing to say yet.
    expect(queryEditorIsOpen("one", "home:block", false)).toBe(false);
    expect(queryEditorIsOpen("one", "home:block", true)).toBe(true);

    rememberQueryEditorOpen("one", "home:block", true);
    expect(queryEditorIsOpen("one", "home:block", false)).toBe(true);
    // Opening one question says nothing about another, or about the same query
    // in a different graph.
    expect(queryEditorIsOpen("one", "home:other", false)).toBe(false);
    expect(queryEditorIsOpen("two", "home:block", false)).toBe(false);
    // The two disclosures are independent: opening the editor folds nothing.
    expect(queryResultsAreOpen("one", "home:block")).toBe(true);

    rememberQueryEditorOpen("one", "home:block", false);
    expect(queryEditorIsOpen("one", "home:block", false)).toBe(false);
    // Nothing opened is nothing stored.
    expect(localStorage.getItem("neoseq.query-editor.v1")).toBeNull();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
