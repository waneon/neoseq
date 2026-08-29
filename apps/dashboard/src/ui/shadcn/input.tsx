import * as React from "react";

import { cn } from "@/lib/utils";

// A field is an inset thing, so it carries the resting ring and no cast — the
// opposite of a button, which is raised. Focus is a luminance step plus the
// accent edge the whole product uses to say "the keys land here"; the ring
// itself stays the resting hairline, so the control never changes silhouette.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-[var(--r-2)] bg-background px-2.5 text-sm text-foreground shadow-[var(--e1)]",
        "transition-shadow placeholder:text-[var(--ink-3)] caret-[var(--accent)]",
        "hover:shadow-[inset_0_0_0_1px_var(--line-strong)]",
        // The accent edge is inset: a field in a scrolling directory can have
        // paint outside its box cropped even though its layout fits.
        "focus-visible:bg-[var(--surface-1)] focus-visible:outline-none focus-visible:shadow-[var(--focus-inset)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
