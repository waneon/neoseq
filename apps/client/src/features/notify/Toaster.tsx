// The toast viewport: fixed to the top-right, above every overlay, portaled to
// the document so no clipping or transformed ancestor can trap it.
//
// It is the one piece of chrome that is neither always visible nor summoned by
// the user — it exists only while something is being reported, and the region
// itself is `pointer-events: none` so an empty viewport can never swallow a
// click meant for the top bar underneath it.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import type { Toast, ToastStore } from "./store";

export function Toaster({ store }: { store: ToastStore }) {
  const toasts = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [backgrounded, setBackgrounded] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  // A toast raised while the tab is in the background must not expire before
  // the tab is looked at again.
  useEffect(() => {
    const read = () => setBackgrounded(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);

  const dismiss = useCallback((id: string) => store.dismiss(id), [store]);
  const paused = hovered || focused || backgrounded;

  return createPortal(
    <div
      className="toast-viewport"
      role="region"
      aria-label="Notifications"
      data-testid="toasts"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // Moving between the action and the dismiss button inside one toast is
        // not leaving; only a focus that lands outside restarts the timers.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} paused={paused} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}

function ToastRow({
  toast,
  paused,
  onDismiss,
}: {
  toast: Toast;
  paused: boolean;
  onDismiss: (id: string) => void;
}) {
  const { id, duration, nonce } = toast;

  useEffect(() => {
    if (paused || duration === null) return;
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
    // `nonce` restarts the countdown when a repeat lands on this toast.
  }, [duration, id, nonce, onDismiss, paused]);

  return (
    <div
      // No entrance animation, and none was a close call: a toast reads like a
      // surface whose arrival is the message, which `enter-fade` exists for. But
      // it is also read the instant it appears — by the user, by a live region,
      // and by the contrast audit, which caught it mid-fade compositing its text
      // against the page behind it. DESIGN.md § Motion rule 3 decides it: prefer
      // no animation to one that has to finish before the surface is legible.
      className="toast"
      data-tone={toast.tone}
      data-testid="toast"
      // Urgency matches the message: a failure interrupts, a notice waits for a
      // gap. `aria-atomic` keeps the reason attached to the thing that failed.
      role={toast.tone === "danger" ? "alert" : "status"}
      aria-atomic="true"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onDismiss(id);
      }}
    >
      <span className="toast-dot" aria-hidden />
      <p className="toast-title">
        {toast.title}
        {toast.count > 1 && (
          <span className="toast-count">
            ×{toast.count}
            <span className="sr-only"> occurrences</span>
          </span>
        )}
      </p>
      <button
        className="icon-btn toast-close"
        aria-label={`Dismiss: ${toast.title}`}
        data-testid="toast-dismiss"
        onClick={() => onDismiss(id)}
      >
        <XIcon aria-hidden />
      </button>
      {toast.detail && <p className="toast-detail">{toast.detail}</p>}
      {toast.action && (
        <div className="toast-actions">
          <button
            className="btn"
            data-testid="toast-action"
            onClick={() => {
              // The toast closes on click; whatever the action starts reports
              // its own outcome, so a stalled retry never leaves a dead button.
              onDismiss(id);
              toast.action?.run();
            }}
          >
            {toast.action.label}
          </button>
        </div>
      )}
    </div>
  );
}
