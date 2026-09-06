import { getConfig } from "@testing-library/react";
import { expect, it } from "vitest";
import { queryExecutionStore } from "../../src/features/query/execution";
import { GRAPH_ID, mountAt, settleQueryPublications } from "./harness";

it("keeps a pending async interaction's environment intact when a background answer finishes", async () => {
  const { session } = await mountAt(`/g/${GRAPH_ID}/custom`);
  const store = queryExecutionStore(session);
  await store.run("probe", "probe", session.getState().canonicalRevision, {
    kind: "raw_sparql",
    language: "sparql-1.1/neoseq-v1",
    source: "SELECT ?subject WHERE { ?subject ?predicate ?object } LIMIT 1",
    bindings: {},
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const interactionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let interaction!: Promise<void>;
  const unsubscribe = store.subscribe("probe", () => {
    // A userEvent or findBy call can start after notification, before the
    // background publication's awaited React work has finished.
    queueMicrotask(() => {
      interaction = getConfig().asyncWrapper(async () => {
        started();
        await pending;
      });
    });
  });
  try {
    store.clear("probe");
    await interactionStarted;
    await settleQueryPublications();
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(
      false,
    );
  } finally {
    release();
    await interaction;
    unsubscribe();
  }
});
