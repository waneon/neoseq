import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useOverlayRoot } from "@/ui/overlay-root";
import { focusOverlayOwner } from "@/ui/overlay-focus";

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn("menu-select", className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return (
    <SelectPrimitive.Value data-slot="select-value" className={cn("value", className)} {...props} />
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 6,
  onCloseAutoFocus,
  ref,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const container = useOverlayRoot();
  const focusOwner = React.useRef<HTMLElement | null>(null);
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        ref={(surface) => {
          // Radix removes aria-controls as the select closes; retain its owner
          // while that relation is still present, before unmount autofocus runs.
          if (surface?.id) {
            focusOwner.current = surface.ownerDocument.querySelector<HTMLElement>(
              `[data-slot="select-trigger"][aria-controls="${CSS.escape(surface.id)}"]`,
            );
          }
          if (typeof ref === "function") return ref(surface);
          if (ref) ref.current = surface;
        }}
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented || !focusOwner.current) return;
          // Select owns a modal focus scope and always returns to its trigger,
          // even when an enclosing dialog has briefly reclaimed focus.
          event.preventDefault();
          focusOverlayOwner(focusOwner.current);
        }}
        className={cn(
          "menu-select-menu z-[var(--z-menu)] min-w-[12rem] rounded-lg bg-[var(--overlay)] p-1 text-popover-foreground shadow-[var(--e2)] enter-fade-fast",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          data-slot="select-viewport"
          className={cn(
            "p-0",
            position === "popper" && "min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-7 pr-2 text-sm text-foreground outline-none transition-colors",
        "focus:bg-accent focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5 text-[var(--accent)]" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
