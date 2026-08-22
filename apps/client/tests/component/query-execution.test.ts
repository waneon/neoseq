import { describe, expect, it, vi } from "vitest";
import type { GraphSession } from "../../src/core-port/session";
import type {
  SparqlQueryRequest,
  SparqlQueryResult,
} from "../../src/generated/core-port";
import {
  QueryExecutionStore,
  queryExecutionSignature,
} from "../../src/features/query/execution";

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
