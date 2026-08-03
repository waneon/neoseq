import type { SessionState } from "../../core-port/session";

export function SaveStatus({
  state,
  onRetry,
}: {
  state: SessionState;
  onRetry: () => void;
}) {
  const save = state.save;
  const label =
    save.kind === "saved"
      ? "Saved locally"
      : save.kind === "saving"
        ? "Saving…"
        : save.code === "storage_full"
          ? "Storage full — not saved"
          : "Not saved";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <output
        className="status-pill"
        data-save={save.kind}
        data-testid="save-status"
        title={save.kind === "unsaved" ? save.message : undefined}
      >
        {label}
      </output>
      {save.kind === "unsaved" && save.retryable && (
        <button className="btn btn-utility" onClick={onRetry} data-testid="retry-save">
          Retry
        </button>
      )}
    </span>
  );
}
