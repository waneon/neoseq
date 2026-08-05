// Test-build-only verification harness. Production routing never imports it.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  runIndexedDbFaultCorpus,
  runIndexedDbPersistenceCorpus,
  runWorkerCorePortCorpus,
} from "../../storage-test-corpus";

type State =
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "passed"; corpus: Corpus };

type Corpus = "persistence" | "core-port" | "recovery";

const corpora = {
  persistence: runIndexedDbPersistenceCorpus,
  "core-port": runWorkerCorePortCorpus,
  recovery: runIndexedDbFaultCorpus,
} satisfies Record<Corpus, () => Promise<unknown>>;

export function StorageVerificationPage() {
  const [state, setState] = useState<State>({ status: "running" });
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("corpus");
  const corpus: Corpus = requested === "core-port" || requested === "recovery"
    ? requested
    : "persistence";

  useEffect(() => {
    let cancelled = false;
    void corpora[corpus]()
      .then(() => {
        if (!cancelled) {
          setState({ status: "passed", corpus });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [corpus]);

  return (
    <main className="picker">
      <div className="picker-inner">
        <p className="eyebrow">Neoseq · Local Persistence</p>
        <h1>Durable locally, identical everywhere.</h1>
        <p className="lede">SQLite and IndexedDB implement one recovery and CorePort v3 contract.</p>
        <section
          aria-live="polite"
          data-testid="result"
          data-status={state.status}
          data-corpus={state.status === "passed" ? state.corpus : corpus}
        >
          {state.status === "running" && <strong>Running {corpus} corpus…</strong>}
          {state.status === "failed" && <strong>Failed: {state.error}</strong>}
          {state.status === "passed" && <strong>Status passed</strong>}
        </section>
      </div>
    </main>
  );
}
