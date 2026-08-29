import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonClass } from "@/ui/shadcn/button";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "enter-fade fixed inset-0 z-[var(--z-dialog)] bg-[var(--scrim)] backdrop-blur-[var(--scrim-blur)]",
        className,
      )}
      {...props}
    />
  );
}

// Centred by a flex wrapper rather than by `-translate-x-1/2 -translate-y-1/2`,
// so the panel's own transform is free for its arrival and it comes to rest at
// `transform: none` — a panel parked on a half-applied translate is a target
// automation reports as unstable. There is no exit animation: Radix unmounts
// immediately rather than leaving a ghost of a dialog that has been answered.
function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel = "Close",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  closeLabel?: string;
}) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center p-4">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            "enter-rise pointer-events-auto relative grid w-full max-w-[420px] gap-4 rounded-[var(--r-4)] bg-[var(--overlay)] p-6 shadow-[var(--e3)] max-[600px]:p-4",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className={cn(buttonClass("secondary", "icon"), "absolute right-3 top-3")}
              aria-label={closeLabel}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1 pr-8", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-[var(--text-lg)] font-semibold leading-[var(--lh-lg)] tracking-[var(--track-lg)] text-[var(--ink)]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm leading-[var(--lh-sm)] text-[var(--ink-2)]", className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle };
