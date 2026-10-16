import * as React from "react";
import {
  Focusable,
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipProps,
  type TooltipTriggerComponentProps,
} from "react-aria-components";

import { cn } from "@/lib/utils";
import { LAYER_STYLE } from "@/ui/overlay-root";

function Tooltip({ delay = 300, ...props }: TooltipTriggerComponentProps) {
  return <AriaTooltipTrigger delay={delay} {...props} />;
}

type FocusableChild = React.ComponentProps<typeof Focusable>["children"];

/**
 * The control the tooltip describes. Focusable types its child as a DOM
 * element; a component that passes its props and ref through to one, as Button
 * does, works the same.
 */
function TooltipTrigger({ children }: { children: React.ReactElement }) {
  return <Focusable>{children as FocusableChild}</Focusable>;
}

// Opacity-only entrance and no exit animation: the zoom/slide variants moved a
// surface that an audit may read and a pointer may already be travelling toward.
function TooltipContent({
  className,
  offset = 6,
  ...props
}: TooltipProps & { className?: string }) {
  return (
    <AriaTooltip
      data-slot="tooltip-content"
      offset={offset}
      style={LAYER_STYLE}
      className={cn(
        "z-[var(--z-popover)] inline-flex w-fit items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background enter-fade-fast",
        className,
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
