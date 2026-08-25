import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonClass } from "@/ui/shadcn/button";

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
        "fixed inset-0 z-[var(--z-dialog)] bg-[var(--scrim)] backdrop-blur-[var(--scrim-blur)] enter-fade",
        className,
      )}
      {...props}
    />
  );
}

// Centred by a flex wrapper rather than `-translate-x-1/2 -translate-y-1/2`, so
// the panel's own transform is free for its arrival and it comes to rest at
// `transform: none` — a panel parked on a half-applied translate is a target
// automation reports as unstable.
//
// The arrival is `--rise` and a hair of scale, finishing opaque in the first 40%
// (designs/foundations.md § Motion), so nothing reads the panel — user,
// screenshot or contrast audit — while it is still translucent. There is no exit
// animation: Radix unmounts immediately rather than leaving a ghost.
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
            "enter-rise pointer-events-auto relative grid w-full max-w-[440px] gap-4 rounded-[var(--r-4)] bg-[var(--overlay)] p-6 shadow-[var(--e3)] max-[600px]:p-4",
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
      className={cn("flex flex-col gap-1 pr-8", className)}
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
        "text-[var(--text-lg)] font-semibold leading-[var(--lh-lg)] tracking-[var(--track-lg)] text-[var(--ink)]",
        className,
      )}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogHeader, DialogTitle };
