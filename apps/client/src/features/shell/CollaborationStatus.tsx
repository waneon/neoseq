import type { SessionState } from "../../core-port/session";
import { useI18n } from "../../i18n";

/** Remote durability and liveness are separate clocks. Both slots stay mounted
 * for tests and assistive technology, while their steady answers stay visually
 * silent beside the local save slot. */
export function CollaborationStatus({ state }: { state: SessionState }) {
  const { message } = useI18n();
  if (state.sync.kind === "local") return null;

  const syncText = state.sync.kind === "pending"
    ? message("sync.pending", { count: state.sync.count })
    : state.sync.kind === "paused"
      ? state.sync.reason === "auth"
        ? message("sync.pausedAuth")
        : state.sync.reason === "revoked"
          ? message("sync.pausedRevoked")
          : message("sync.incompatible")
      : state.sync.kind === "error"
        ? message("sync.notSynced")
        : null;
  const liveText = state.live === "connecting"
    ? message("sync.connecting")
    : state.live === "offline"
      ? message("sync.offline")
      : null;

  return (
    <>
      <output
        className="sync-slot"
        data-sync={state.sync.kind}
        data-testid="sync-status"
        aria-live={state.sync.kind === "error" || state.sync.kind === "paused" ? "assertive" : "polite"}
      >
        {state.sync.kind === "synced" && <span className="sr-only">{message("sync.synced")}</span>}
        {syncText && <><span className="status-dot" aria-hidden /><span>{syncText}</span></>}
      </output>
      <output
        className="live-slot"
        data-live={state.live}
        data-testid="live-status"
        aria-live="polite"
      >
        {state.live === "live" && <span className="sr-only">{message("sync.live")}</span>}
        {liveText && <><span className="status-dot" aria-hidden /><span>{liveText}</span></>}
      </output>
    </>
  );
}
