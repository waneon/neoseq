import { useState, type ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/shadcn/dialog";
import { OverlayRoot } from "@/ui/overlay-root";
import { cn } from "@/lib/utils";
import { useI18n } from "../i18n";

export function Dialog({
  title,
  onClose,
  size = "default",
  dismissible = true,
  children,
}: {
  title: string;
  onClose: () => void;
  /** `settings` is the two-pane dialog: wider, and it owns its own scrolling. */
  size?: "default" | "wide" | "settings";
  dismissible?: boolean;
  children: ReactNode;
}) {
  const { message } = useI18n();
  // The panel itself, once it exists. Everything a dialog summons — a menu, an
  // anchored panel, an autocomplete — is portaled into it rather than onto the
  // body, because the scroll lock, the pointer-events lock and the focus trap a
  // modal installs all stop at this element (§ ui/overlay-root).
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  // Rendered only while open (parents mount it conditionally), so the Radix
  // root is always open; closing via Escape, the backdrop, or the X reports
  // back through onOpenChange. Radix owns focus trapping and restoration.
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        ref={setSurface}
        closeLabel={message("common.close")}
        showCloseButton={dismissible}
        className={cn(
          size !== "settings" && "max-h-[calc(100dvh-2rem)] overflow-y-auto",
          size === "wide" && "max-w-[720px]",
          size === "settings" && "max-w-[820px]",
        )}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!dismissible) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
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
