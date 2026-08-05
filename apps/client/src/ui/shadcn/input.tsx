import * as React from "react";

import { cn } from "@/lib/utils";

// Field focus is a quiet luminance step with the same resting edge. Indigo is
// reserved for actions and carets, so ordinary form navigation never draws a
// blue frame around the control.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-md bg-background px-2.5 text-sm text-foreground shadow-[var(--e1)]",
        "placeholder:text-[var(--ink-3)] caret-[var(--accent)]",
        "focus-visible:bg-[var(--surface-2)] focus-visible:shadow-[var(--e1)]",
        "read-only:text-[var(--ink-2)] disabled:cursor-not-allowed disabled:opacity-50",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
