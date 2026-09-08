import { useState, type ReactNode } from "react";
import { Dialog as DialogRoot, DialogContent, DialogHeader, DialogTitle } from "@/ui/shadcn/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/shadcn/alert-dialog";
import { Button } from "@/ui/shadcn/button";
import { OverlayRoot } from "@/ui/overlay-root";
import { currentFocusOwner, focusOverlayOwner, restoreOverlayFocus } from "@/ui/overlay-focus";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";

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
  const [focusOwner] = useState(currentFocusOwner);
  // The panel itself, once it exists. Everything a dialog summons — a menu, an
  // anchored panel, an autocomplete — is portaled into it rather than onto the
  // body, because the scroll lock, the pointer-events lock and the focus trap a
  // modal installs all stop at this element (§ ui/overlay-root).
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  // Rendered only while open (parents mount it conditionally), so the Radix
  // root is always open; closing via Escape, the backdrop, or the X reports
  // back through onOpenChange. There is no Radix Trigger in this composition,
  // so retain the invoker ourselves while Radix owns the focus lifecycle.
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        ref={setSurface}
        closeLabel={message("common.close")}
        showCloseButton={dismissible}
        aria-describedby={undefined}
        className={cn(
          size === "wide" && "max-w-[720px]",
          size === "settings" && "settings-dialog-surface max-w-[940px] gap-0 p-0 max-[600px]:p-0",
        )}
        onEscapeKeyDown={(event) => {
          // Radix arbitrates layers during document capture, before a field's
          // keydown can discard its draft. A dirty field explicitly retains
          // this Escape; the next one can dismiss the surrounding dialog.
          const target = event.target;
          const cancelsDraft =
            target instanceof Element && target.closest('[data-escape-cancel="true"]');
          if (!dismissible || event.isComposing || cancelsDraft) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        onCloseAutoFocus={(event) => restoreOverlayFocus(event, returnFocus?.() ?? focusOwner)}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <OverlayRoot node={surface}>{children}</OverlayRoot>
      </DialogContent>
    </DialogRoot>
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
  const [focusOwner] = useState(currentFocusOwner);
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
    <AlertDialog open>
      <AlertDialogContent
        aria-busy={working || undefined}
        onCloseAutoFocus={(event) => {
          if (returnFocus) {
            event.preventDefault();
            focusOverlayOwner(returnFocus());
          } else {
            restoreOverlayFocus(event, focusOwner);
          }
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!working) close();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="dialog-actions">
          <AlertDialogCancel asChild>
            <Button variant="secondary" disabled={working} onClick={close}>
              {cancelLabel}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant="destructive"
              disabled={working}
              data-testid={testId}
              onClick={(event) => {
                // A destructive operation owns the lifetime of its dialog: it
                // remains visible until the operation has actually committed.
                event.preventDefault();
                void confirm();
              }}
            >
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
