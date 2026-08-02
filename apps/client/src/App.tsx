import { useEffect, useState } from "react";
import { CORE_PORT_VERSION } from "./generated/core-port";
import { CoreWorker } from "./core-worker";
import { loadSnapshot, saveSnapshot } from "./persistence";
import "./style.css";

type State =
  | { status: "running" }
  | { status: "failed"; error: string }
  | {
      status: "passed";
      coreVersion: string;
      fixtureHash: string;
      restoredHash: string;
    };

export default function App() {
  const [state, setState] = useState<State>({ status: "running" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const creator = new CoreWorker();
      try {
        const created = await creator.create();
        if (created.contractVersion !== CORE_PORT_VERSION) {
          throw new Error("CorePort version mismatch");
        }
        await saveSnapshot(created.payload);
        creator.close();

        const restorer = new CoreWorker();
        const persisted = await loadSnapshot();
        const restored = await restorer.restore(persisted);
        restorer.close();
        if (created.hash !== restored.hash) {
          throw new Error("IndexedDB round-trip hash mismatch");
        }
        localStorage.setItem("neoseq-step-1-hash", restored.hash);
        if (!cancelled) {
          setState({
            status: "passed",
            coreVersion: created.coreVersion,
            fixtureHash: created.hash,
            restoredHash: restored.hash,
          });
        }
      } catch (error) {
        creator.close();
        if (!cancelled) {
          setState({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <p className="eyebrow">NeoSeq · Architecture Spike</p>
      <h1>One Rust core, every client.</h1>
      <p>
        This shell verifies the same Loro fixture through a WebAssembly Worker and
        IndexedDB reload boundary.
      </p>
      <section aria-live="polite" data-testid="result" data-status={state.status}>
        {state.status === "running" && <strong>Running feasibility checks…</strong>}
        {state.status === "failed" && <strong>Failed: {state.error}</strong>}
        {state.status === "passed" && (
          <dl>
            <div><dt>Status</dt><dd>passed</dd></div>
            <div><dt>Core</dt><dd>{state.coreVersion}</dd></div>
            <div><dt>Fixture</dt><dd>{state.fixtureHash}</dd></div>
            <div><dt>Restored</dt><dd>{state.restoredHash}</dd></div>
          </dl>
        )}
      </section>
    </main>
  );
}

