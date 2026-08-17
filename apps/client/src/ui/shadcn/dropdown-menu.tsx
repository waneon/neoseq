import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function DropdownMenu(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  );
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[var(--z-menu)] min-w-[12rem] overflow-hidden rounded-lg bg-[var(--overlay)] p-1 text-popover-foreground shadow-[var(--e2)]",
          // Opacity-only entrance and no exit animation, so the menu is
          // positionally stable while the pointer travels to it and Radix
          // unmounts it immediately on close rather than leaving a low-opacity
          // ghost that is neither clickable nor contrast-safe.
          "enter-fade-fast",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm text-foreground outline-none transition-colors",
        // Pointer hover and keyboard focus share one highlight, so "where am I"
        // never has two answers.
        "focus:bg-accent focus:text-accent-foreground",
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-[var(--danger-soft)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        "[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-[var(--ink-3)]",
        "data-[variant=destructive]:[&_svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A choice within a group of them — the row a `<select>`'s option becomes now
 * that every list of choices in the product opens the same menu. It reserves the
 * indicator's column whether or not it is the selected one, so a menu of options
 * does not shift its text sideways as the selection moves down it.
 */
function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>,
) {
  return (
    <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-7 pr-2 text-sm text-foreground outline-none transition-colors",
        "focus:bg-accent focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5 text-[var(--accent)]" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

/**
 * The shortcut column. Every menu item that has a keyboard binding shows it
 * here — one of the five surfaces that teach the command layer, and the reason
 * a hover-revealed control is discoverable rather than hidden.
 *
 * It holds a `<Kbd>`, which owns how a modifier and its key are set (app.css
 * § .kbd); this element contributes position only. It used to declare the mono
 * face and `--ink-3` itself, which is how a menu row ended up drawing `⌘P` in a
 * font that renders those three glyphs at three different sizes, in an ink that
 * fails contrast the moment the row takes its `--surface-2` highlight.
 */
function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto flex items-center pl-4", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
};
