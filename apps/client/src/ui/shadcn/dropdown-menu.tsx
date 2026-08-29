import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon } from "lucide-react";

import { useOverlayRoot } from "@/ui/overlay-root";
import { cn } from "@/lib/utils";

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  // A menu opened from inside a modal belongs inside it, not on the body behind
  // it — a non-modal menu portaled onto the body cannot be scrolled or clicked
  // through a dialog's locks (§ ui/overlay-root).
  const container = useOverlayRoot();
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          // No `overflow-hidden` here: a menu's box — its cap and its scrolling —
          // is declared in `app.css`, because a utility would outrank it and did.
          "z-[var(--z-menu)] min-w-[12rem] rounded-lg bg-[var(--overlay)] p-1 text-popover-foreground shadow-[var(--e2)]",
          // One arrival, no exit: the menu rises the system's `--rise` and
          // settles, and Radix unmounts it immediately on close rather than
          // leaving a low-opacity ghost that is neither clickable nor
          // contrast-safe. Opacity finishes in the first 40% of the animation,
          // so the surface is never read — by a person or by the contrast
          // audit — while it is still translucent.
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
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
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
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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

/**
 * The heading over a section of a menu. It takes `.group-label`, which is the
 * product's one group-divider rule (designs/foundations.md § Typography): four signals in
 * agreement — smaller, heavier, tracked out, a step quieter — because one step of
 * anything reads as the first item of its own list rather than as its heading.
 * No menu is allowed to invent its own.
 */
function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("group-label flex min-h-[24px] items-center px-2 pt-1", className)}
      {...props}
    />
  );
}

/**
 * A switch inside a menu — one state the reader turns on or off, as against the
 * `RadioItem`'s one-of-many. It reserves the same indicator column, at the same
 * width, so a menu that mixes the two (a result's view, its columns, its row
 * height) keeps every label on one left edge.
 */
function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "relative flex min-h-[30px] cursor-pointer select-none items-center gap-2 rounded-md py-1 pl-7 pr-2 text-sm text-foreground outline-none transition-colors",
        "focus:bg-accent focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
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
    </DropdownMenuPrimitive.CheckboxItem>
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
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
};
