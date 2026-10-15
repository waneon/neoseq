import { useId, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button, buttonClass } from "@/ui/shadcn/button";
import { ModalLayer } from "@/ui/modal";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";

const TITLE_CLASS =
  "text-[var(--text-lg)] font-semibold leading-[var(--lh-lg)] tracking-[var(--track-lg)] text-[var(--ink)]";

// The panel is centred by its frame rather than `-translate-x-1/2
// -translate-y-1/2`, so it rests at `transform: none` — a panel parked on a
// half-applied translate is a target automation reports as unstable.
export function Dialog({
  title,
  onClose,
  size = "default",
  dismissible = true,
  returnFocus,
  children,
}: {
  title: string;
  onClose: () => void;
  /** `settings` is the two-pane dialog: wider, and it owns its own scrolling. */
  size?: "default" | "wide" | "settings";
  dismissible?: boolean;
  /** Resolves a persistent owner when the invoking control is replaced or removed. */
  returnFocus?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const { message } = useI18n();
  const titleId = useId();
  return (
    <ModalLayer
      frameClassName="dialog-frame"
      className={cn(
        "dialog-surface relative grid w-full gap-4",
        size === "wide" && "max-w-[720px]",
        size === "settings" && "settings-dialog-surface max-w-[940px] gap-0 p-0 max-[600px]:p-0",
      )}
      aria-labelledby={titleId}
      dismissible={dismissible}
      returnFocus={returnFocus}
      onEscapeKeyDown={(event) => {
        // Escape during composition belongs to the input method.
        if (!dismissible || event.isComposing) event.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="dialog-header flex flex-col gap-1 pr-8">
        <h2 id={titleId} className={TITLE_CLASS}>
          {title}
        </h2>
      </div>
      {children}
      {dismissible && (
        <button
          type="button"
          className={cn(buttonClass("secondary", "icon"), "dialog-close absolute")}
          aria-label={message("common.close")}
          onClick={onClose}
        >
          <XIcon className="size-[var(--dialog-close-icon,0.875rem)]" />
        </button>
      )}
    </ModalLayer>
  );
}

/**
 * An inline notice. A danger tone is an `alert`, not a polite `status` — a
 * data-recovery warning that is announced politely may never be announced at
 * all.
 */
export function Callout({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      className={tone === "danger" ? "callout callout-danger" : "callout"}
      role={tone === "danger" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

/** A destructive choice with the safe action as its initial focus. */
export function ConfirmDialog({
  title,
  cancelLabel,
  confirmLabel,
  busy = false,
  testId,
  returnFocus,
  onClose,
  onConfirm,
  onConfirmError,
  children,
}: {
  title: string;
  cancelLabel: string;
  confirmLabel: string;
  busy?: boolean;
  testId?: string;
  returnFocus?: () => HTMLElement | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  onConfirmError?: (cause: unknown) => void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const working = busy || pending;
  const close = onClose;

  const confirm = async () => {
    if (working) return;
    setPending(true);
    try {
      await onConfirm();
      close();
    } catch (cause) {
      setPending(false);
      onConfirmError?.(cause);
    }
  };

  return (
    <ModalLayer
      role="alertdialog"
      frameClassName="dialog-frame"
      className="dialog-surface relative grid w-full gap-4"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={working || undefined}
      dismissible={false}
      returnFocus={returnFocus}
      onEscapeKeyDown={(event) => {
        if (working) event.preventDefault();
      }}
      onClose={close}
    >
      <div className="flex flex-col gap-2">
        <h2 id={titleId} className={TITLE_CLASS}>
          {title}
        </h2>
        <div id={descriptionId} className="text-sm text-[var(--ink-2)]">
          {children}
        </div>
      </div>
      <div className="dialog-actions">
        <Button variant="secondary" disabled={working} onClick={close}>
          {cancelLabel}
        </Button>
        {/* A destructive operation owns the lifetime of its dialog: it remains
            visible until the operation has actually committed. */}
        <Button
          variant="destructive"
          disabled={working}
          data-testid={testId}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </div>
    </ModalLayer>
  );
}
