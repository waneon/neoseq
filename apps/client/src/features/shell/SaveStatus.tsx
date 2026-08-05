import { useEffect, useState } from "react";
import type { SessionState } from "../../core-port/session";
import { useI18n } from "../../i18n";

const SAVING_DELAY_MS = 600;

/**
 * Durability, stated only when it is not the boring answer.
 *
 * `saved` renders nothing visible — an interface that permanently announces that
 * nothing is wrong is noise, and as a polite live region it also announced every
 * debounced keystroke to a screen reader while the user was typing. `saving`
 * waits 600ms so ordinary typing never flickers a dot. `unsaved` is loud: a
 * danger dot, the reason as plain visible text rather than a `title` attribute,
 * and the retry beside it.
 *
 * The element stays mounted with its `data-save` attribute in every state,
 * because durability is also the thing the rest of the app waits on.
 */
export function SaveStatus({
  state,
  onRetry,
}: {
  state: SessionState;
  onRetry: () => void;
}) {
  const { message } = useI18n();
  const save = state.save;
  const [showSaving, setShowSaving] = useState(false);

  useEffect(() => {
    if (save.kind !== "saving") {
      setShowSaving(false);
      return;
    }
    const timer = setTimeout(() => setShowSaving(true), SAVING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [save.kind]);

  const reason =
    save.kind === "unsaved"
      ? save.code === "storage_full"
        ? message("save.storageFull")
        : message("save.notSaved")
      : null;

  return (
    <>
      <output
        className="save-slot"
        data-save={save.kind}
        data-save-code={save.kind === "unsaved" ? save.code : undefined}
        data-testid="save-status"
        aria-live={save.kind === "unsaved" ? "assertive" : "off"}
      >
        {save.kind === "saved" && (
          <span className="sr-only">{message("save.saved")}</span>
        )}
        {save.kind === "saving" && showSaving && (
          <>
            <span className="save-dot" aria-hidden />
            <span className="sr-only">{message("save.saving")}</span>
          </>
        )}
        {reason && (
          <>
            <span className="save-dot" aria-hidden />
            <span>{reason}</span>
          </>
        )}
      </output>
      {save.kind === "unsaved" && save.retryable && (
        <button className="btn" onClick={onRetry} data-testid="retry-save">
          {message("common.retryShort")}
        </button>
      )}
    </>
  );
}
