import { type ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/shadcn/dialog";
import { cn } from "@/lib/utils";

export function Dialog({
  title,
  onClose,
  size = "default",
  children,
}: {
  title: string;
  onClose: () => void;
  size?: "default" | "wide";
  children: ReactNode;
}) {
  // Rendered only while open (parents mount it conditionally), so the Radix
  // root is always open; closing via Escape, the backdrop, or the X reports
  // back through onOpenChange. Radix owns focus trapping and restoration.
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={cn(size === "wide" && "max-w-[720px]")}
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
