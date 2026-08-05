import { type ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/shadcn/dialog";
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
  // Rendered only while open (parents mount it conditionally), so the Radix
  // root is always open; closing via Escape, the backdrop, or the X reports
  // back through onOpenChange. Radix owns focus trapping and restoration.
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        closeLabel={message("common.close")}
        showCloseButton={dismissible}
        className={cn(
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
        {children}
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
