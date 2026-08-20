// The toast viewport: fixed to the top-right, above every overlay, portaled to
// the document so no clipping or transformed ancestor can trap it.
//
// It is the one piece of chrome that is neither always visible nor summoned by
// the user — it exists only while something is being reported, and the region
// itself is `pointer-events: none` so an empty viewport can never swallow a
// click meant for the top bar underneath it.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, XIcon } from "lucide-react";
import type { Toast, ToastStore, ToastTone } from "./store";
import { useI18n } from "../../i18n";

/**
 * Tone, as a glyph.
 *
 * It was a 5px dot in the tone's colour — the save slot's own language, borrowed.
 * That works for durability, which has two states the user already knows, and it
 * does not work here: a report can be a failure, a plain notice or a confirmation,
 * and a coloured disc distinguishes those only for someone who has learned which
 * colour is which, and not at all for someone who cannot tell the two apart. A
 * glyph is legible before the sentence beside it is read, which on the one surface
 * the user never asked for is the whole job.
 *
 * The title still says what happened. Tone is still never the only signal — it is
 * now a second one that stands on its own.
 */
const TONE_ICON: Record<ToastTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CircleCheckIcon,
  danger: CircleAlertIcon,
};

export function Toaster({ store }: { store: ToastStore }) {
  const { message } = useI18n();
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
      aria-label={message("notify.notifications")}
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
        <ToastRow
          key={toast.id}
          toast={toast}
          paused={paused}
          onDismiss={dismiss}
          occurrenceLabel={message("notify.occurrences", { count: toast.count })}
          dismissLabel={message("notify.dismiss", { title: toast.title })}
        />
      ))}
    </div>,
    document.body,
  );
}

function ToastRow({
  toast,
  paused,
  onDismiss,
  occurrenceLabel,
  dismissLabel,
}: {
  toast: Toast;
  paused: boolean;
  onDismiss: (id: string) => void;
  occurrenceLabel: string;
  dismissLabel: string;
}) {
  const { id, duration, nonce } = toast;
  const ToneIcon = TONE_ICON[toast.tone];
  // How much of the window is left. A pause has to *hold* the remaining time,
  // not restart it: the bar and the timer would otherwise disagree the moment
  // the pointer left, and the bar is the honest one — the browser keeps a paused
  // animation exactly where it stopped.
  const remaining = useRef(duration);

  useEffect(() => {
    remaining.current = duration;
  }, [duration, nonce]);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [id, nonce, onDismiss, paused]);

  return (
    <div
      // The arrival is a translate and nothing else. A toast reads like a
      // surface whose arrival is the message, so it should move — but it is also
      // read the instant it appears, by the user, by a live region, and by the
      // contrast audit, which caught an earlier fade compositing its text
      // against the page behind it. `enter-drop` is the answer DESIGN.md
      // § Motion names for exactly this case: full opacity on the first frame,
      // and the movement carries the arrival on its own.
      className="toast enter-drop"
      data-tone={toast.tone}
      data-paused={paused}
      data-testid="toast"
      style={{ "--toast-duration": `${duration}ms` } as React.CSSProperties}
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
      <ToneIcon className="toast-icon" aria-hidden />
      <p className="toast-title">
        {toast.title}
        {toast.count > 1 && (
          <span className="toast-count">
            ×{toast.count}
            <span className="sr-only"> {occurrenceLabel}</span>
          </span>
        )}
      </p>
      <button
        className="icon-btn toast-close"
        aria-label={dismissLabel}
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
      {/* Keyed by `nonce` so a repeat lands as a fresh element and the countdown
          starts over rather than finishing on the previous occurrence's clock. */}
      <span key={nonce} className="toast-timer" data-testid="toast-timer" aria-hidden />
    </div>
  );
}
