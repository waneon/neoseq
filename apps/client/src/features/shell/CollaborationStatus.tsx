import { useEffect, useState } from "react";
import type { SessionState } from "../../core-port/session";
import { useI18n } from "../../i18n";

const PENDING_DELAY_MS = 600;

/**
 * Remote durability and liveness are separate clocks, so they get separate
 * slots beside the local save slot — and the same manners. The steady answers
 * (`synced`, `live`) render nothing visible: an interface that permanently
 * announces that nothing is wrong is noise. `pending` waits 600ms so an outbox
 * that drains between two keystrokes never flickers a dot, and it stays silent
 * at a count of zero, which is what every reconnect briefly reports. Both
 * slots keep their data attributes in every state, because sync is also the
 * thing tests wait on.
 */
export function CollaborationStatus({ state }: { state: SessionState }) {
  const { message } = useI18n();
  const sync = state.sync;
  const pending = sync.kind === "pending" && sync.count > 0;
  const [showPending, setShowPending] = useState(false);

  useEffect(() => {
    if (!pending) {
      setShowPending(false);
      return;
    }
    const timer = setTimeout(() => setShowPending(true), PENDING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  if (sync.kind === "local") return null;

  const syncText =
    sync.kind === "pending"
      ? pending && showPending
        ? message("sync.pending", { count: sync.count })
        : null
      : sync.kind === "paused"
        ? sync.reason === "auth"
          ? message("sync.pausedAuth")
          : sync.reason === "revoked"
            ? message("sync.pausedRevoked")
            : message("sync.incompatible")
        : sync.kind === "error"
          ? message("sync.notSynced")
          : null;
  const liveText =
    state.live === "connecting"
      ? message("sync.connecting")
      : state.live === "offline"
        ? message("sync.offline")
        : null;

  return (
    <>
      <output
        className="sync-slot"
        data-sync={sync.kind}
        data-testid="sync-status"
        aria-live={sync.kind === "error" || sync.kind === "paused" ? "assertive" : "off"}
      >
        {sync.kind === "synced" && <span className="sr-only">{message("sync.synced")}</span>}
        {syncText && (
          <>
            <span className="save-dot" aria-hidden />
            <span>{syncText}</span>
          </>
        )}
      </output>
      <output
        className="live-slot"
        data-live={state.live}
        data-testid="live-status"
        aria-live={state.live === "offline" ? "polite" : "off"}
      >
        {state.live === "live" && <span className="sr-only">{message("sync.live")}</span>}
        {liveText && (
          <>
            <span className="save-dot" aria-hidden />
            <span>{liveText}</span>
          </>
        )}
      </output>
    </>
  );
}
