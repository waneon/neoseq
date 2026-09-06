import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphSession } from "../../src/core-port/session";
import type { SparqlQueryRequest, SparqlQueryResult } from "../../src/generated/core-port";
import { QueryExecutionStore, queryExecutionSignature } from "../../src/features/query/execution";
import {
  queryResultsAreOpen,
  rememberQueryResultsOpen,
  resetQueryDisclosure,
} from "../../src/features/query/presentation";

const REQUEST_A: SparqlQueryRequest = {
  kind: "raw_sparql",
  language: "sparql-1.1/neoseq-v1",
  source: "ASK { ?a ?b ?c }",
  bindings: {},
};
const REQUEST_B: SparqlQueryRequest = {
  kind: "raw_sparql",
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
    const store = new QueryExecutionStore(mockSession(query));
    const signature = queryExecutionSignature(REQUEST_A);

    const first = store.run("home:block", signature, 1, REQUEST_A);
    const duplicate = store.run("home:block", signature, 1, REQUEST_A);
    expect(query).toHaveBeenCalledTimes(1);
    expect(store.snapshot("home:block", signature, 1).loading).toBe(true);

    pending.resolve(RESULT_TRUE);
    await Promise.all([first, duplicate]);
    expect(store.snapshot("home:block", signature, 1)).toMatchObject({
      frame: { request: REQUEST_A, result: RESULT_TRUE, canonicalRevision: 1 },
      error: null,
      loading: false,
    });

    await store.run("home:block", signature, 1, REQUEST_A);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not let superseded work replace a cache hit", async () => {
    const pendingB = deferred<SparqlQueryResult>();
    const query = vi.fn((request: SparqlQueryRequest) =>
      request.source === REQUEST_A.source ? Promise.resolve(RESULT_TRUE) : pendingB.promise,
    );
    const store = new QueryExecutionStore(mockSession(query));
    const signatureA = queryExecutionSignature(REQUEST_A);
    const signatureB = queryExecutionSignature(REQUEST_B);

    await store.run("home:block", signatureA, 1, REQUEST_A);
    const obsolete = store.run("home:block", signatureB, 1, REQUEST_B);
    await store.run("home:block", signatureA, 1, REQUEST_A);

    pendingB.resolve(RESULT_FALSE);
    await obsolete;
    expect(store.snapshot("home:block", signatureA, 1).frame?.result).toEqual(RESULT_TRUE);
  });

  it("retains the executed question with a stale visible answer", async () => {
    const pending = deferred<SparqlQueryResult>();
    const query = vi.fn((request: SparqlQueryRequest) =>
      request.source === REQUEST_A.source ? Promise.resolve(RESULT_TRUE) : pending.promise,
    );
    const store = new QueryExecutionStore(mockSession(query));
    const signatureA = queryExecutionSignature(REQUEST_A);
    const signatureB = queryExecutionSignature(REQUEST_B);
    await store.run("answer", signatureA, 1, REQUEST_A);
    const refresh = store.run("answer", signatureB, 1, REQUEST_B);
    expect(store.snapshot("answer", signatureB, 1)).toMatchObject({
      frame: { request: REQUEST_A, result: RESULT_TRUE, canonicalRevision: 1 },
      loading: true,
    });
    pending.resolve(RESULT_FALSE);
    await refresh;
    expect(store.snapshot("answer", signatureB, 1).frame).toEqual({
      request: REQUEST_B,
      result: RESULT_FALSE,
      canonicalRevision: 1,
    });
  });

  it("caches the actual execution revision rather than the scheduling revision", async () => {
    const queryFrame = vi.fn(async (request: SparqlQueryRequest) => ({
      request,
      result: RESULT_TRUE,
      canonicalRevision: 2,
    }));
    const store = new QueryExecutionStore({ queryFrame } as unknown as GraphSession);
    const signature = queryExecutionSignature(REQUEST_A);
    await store.run("answer", signature, 1, REQUEST_A);
    expect(store.snapshot("answer", signature, 2).frame?.canonicalRevision).toBe(2);
    await store.run("answer", signature, 2, REQUEST_A);
    expect(queryFrame).toHaveBeenCalledTimes(1);
  });

  it("owns every in-flight answer until the store is idle", async () => {
    const first = deferred<SparqlQueryResult>();
    const second = deferred<SparqlQueryResult>();
    const query = vi.fn((request: SparqlQueryRequest) =>
      request.source === REQUEST_A.source ? first.promise : second.promise,
    );
    const store = new QueryExecutionStore(mockSession(query));
    const signatureA = queryExecutionSignature(REQUEST_A);
    const signatureB = queryExecutionSignature(REQUEST_B);
    store.run("home:first", signatureA, 1, REQUEST_A);
    store.run("home:second", signatureB, 1, REQUEST_B);

    let idle = false;
    const settled = store.whenIdle().then(() => {
      idle = true;
    });
    first.resolve(RESULT_TRUE);
    await first.promise;
    await Promise.resolve();
    expect(idle).toBe(false);

    second.resolve(RESULT_FALSE);
    await settled;
    expect(idle).toBe(true);
  });
});

describe("query result disclosure", () => {
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

function mockSession(
  query: (request: SparqlQueryRequest) => Promise<SparqlQueryResult>,
): GraphSession {
  return {
    queryFrame: (request: SparqlQueryRequest) =>
      query(request).then((result) => ({
        request,
        result,
        canonicalRevision: 1,
      })),
  } as unknown as GraphSession;
}
