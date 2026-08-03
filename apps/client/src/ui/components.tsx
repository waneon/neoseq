import { type ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/shadcn/dialog";

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Rendered only while open (parents mount it conditionally), so the Radix
  // root is always open; closing via Escape, the backdrop, or the X reports
  // back through onOpenChange. Radix owns focus trapping and restoration.
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
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

export function Callout({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "danger";
  children: ReactNode;
}) {
  return (
    <div className={tone === "danger" ? "callout callout-danger" : "callout"} role="status">
      {children}
    </div>
  );
}
