import * as React from "react";

import { cn } from "@/lib/utils";

// One focus signal, and it is the field's own edge rather than a ring around it.
//
// The resting edge is the `--e1` inset ring, not a border, so a field never
// contributes to a "bordered box" look; on focus that same edge goes 2px
// `--accent`. That is the whole change from the global offset outline, and the
// reason for it is in app.css § focus: a text field is the one control browsers
// match `:focus-visible` on for a plain mouse click, so the offset ring appeared
// every single time anyone clicked into any field in the product. Same colour,
// same 2px, radius inherited, and nothing outside the control moves.
//
// Still no stack of three: no `outline-none` plus a ring plus a recoloured border
// at three different offsets, which is what v1 shipped.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-md bg-background px-2.5 text-sm text-foreground shadow-[var(--e1)]",
        "placeholder:text-[var(--ink-3)] caret-[var(--accent)]",
        "focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
        "read-only:text-[var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-50",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
