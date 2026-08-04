import * as React from "react";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A native <select> styled to match the Input. Kept native (not the Radix
 * Select) so it keeps the platform picker, mobile wheel, type-ahead and AT
 * support, and stays directly driven by the value model — the whole app
 * addresses property enums this way.
 *
 * `color-scheme: light dark` on the root is what makes the popup itself follow
 * the theme; without it a native menu renders in the light UA palette on a dark
 * page, which is the most common tell of a web app that only pretends to have a
 * dark mode.
 */
function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <div className="relative w-full">
      <select
        data-slot="native-select"
        className={cn(
          "h-8 w-full appearance-none rounded-md bg-background pl-2.5 pr-8 text-sm text-foreground shadow-[var(--e1)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--ink-3)]" />
    </div>
  );
}

export { NativeSelect };
