import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal(
  props: React.ComponentProps<typeof DialogPrimitive.Portal>,
) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-[var(--z-dialog)] bg-[var(--scrim)] enter-fade",
        className,
      )}
      {...props}
    />
  );
}

// Centred by a flex wrapper rather than `-translate-x-1/2 -translate-y-1/2`, so
// the panel carries no transform at all — a moving panel is a target automation
// reports as unstable.
//
// The panel also does not fade. Only the scrim does. A dialog is read the instant
// it opens — by the user, by a screenshot, and by the contrast audit — and text
// mid-fade composites against its background at partial alpha. There is no exit
// animation either, so Radix unmounts immediately rather than leaving a ghost.
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
    <DialogPortal>
      <DialogOverlay />
      <div className="pointer-events-none fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center p-4">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            // 600px is the design system's own compact breakpoint (the gutter
            // steps down there too) — not Tailwind's 640px `sm`.
            "pointer-events-auto relative grid w-full max-w-[440px] gap-4 rounded-xl bg-[var(--overlay)] p-6 shadow-[var(--e3)] max-[600px]:p-4",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="absolute right-3 top-3 inline-flex size-6 items-center justify-center rounded-md text-[var(--ink-3)] transition-colors hover:bg-accent hover:text-foreground"
              aria-label={closeLabel}
            >
              <XIcon className="size-3.5" />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-8", className)}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-[19px] font-semibold leading-[25px] tracking-[-0.012em]",
        className,
      )}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogHeader, DialogTitle };
