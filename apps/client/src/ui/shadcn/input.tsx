import * as React from "react";

import { cn } from "@/lib/utils";

// One focus signal: the global `:focus-visible` outline. No `outline-none`, no
// ring, no border recolour — v1 stacked all three at three different offsets and
// then changed the radius as well. The resting edge is the `--e1` inset ring
// rather than a border, so a field never contributes to a "bordered box" look.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-md bg-background px-2.5 text-sm text-foreground shadow-[var(--e1)]",
        "placeholder:text-[var(--ink-3)] caret-[var(--accent)]",
        "read-only:text-[var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-50",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
