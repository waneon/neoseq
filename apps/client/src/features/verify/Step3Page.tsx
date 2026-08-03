// Step 3 verification harness, kept on a dedicated route so the persistence,
// CorePort, and recovery gates keep running against the production bundle.

import { useEffect, useState } from "react";
import {
  runIndexedDbFaultCorpus,
  runIndexedDbPersistenceCorpus,
  runWorkerCorePortCorpus,
} from "../../step3-corpus";

type State =
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "passed"; persistence: boolean; corePort: boolean; recovery: boolean };

export function Step3Page() {
  const [state, setState] = useState<State>({ status: "running" });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      runIndexedDbPersistenceCorpus(),
      runWorkerCorePortCorpus(),
      runIndexedDbFaultCorpus(),
    ])
      .then(() => {
        if (!cancelled) {
          setState({ status: "passed", persistence: true, corePort: true, recovery: true });
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
  }, []);

  return (
    <main className="picker">
      <div className="picker-inner">
        <p className="eyebrow">NeoSeq · Local Persistence</p>
        <h1>Durable locally, identical everywhere.</h1>
        <p className="lede">SQLite and IndexedDB implement one recovery and CorePort v1 contract.</p>
        <section
          aria-live="polite"
          data-testid="result"
          data-status={state.status}
          data-persistence={state.status === "passed" ? String(state.persistence) : "false"}
          data-core-port={state.status === "passed" ? String(state.corePort) : "false"}
          data-recovery={state.status === "passed" ? String(state.recovery) : "false"}
        >
          {state.status === "running" && <strong>Running persistence corpus…</strong>}
          {state.status === "failed" && <strong>Failed: {state.error}</strong>}
          {state.status === "passed" && <strong>Status passed</strong>}
        </section>
      </div>
    </main>
  );
}
