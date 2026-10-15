import * as React from "react";
import {
  Button as AriaButton,
  Header,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Pressable,
  Separator,
  type ButtonProps,
  type Key,
  type MenuItemProps,
  type Placement,
} from "react-aria-components";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LAYER_STYLE } from "@/ui/overlay-root";
import { afterArrivals, menuOwnerRef, restoreOverlayFocus } from "@/ui/overlay-focus";

// A non-modal menu leaves the page live: a press outside both dismisses it and
// lands where it was aimed.
const ModalContext = React.createContext(true);

function DropdownMenu({
  open,
  onOpenChange,
  modal = true,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ModalContext.Provider value={modal}>
      <MenuTrigger isOpen={open} onOpenChange={onOpenChange}>
        {children}
      </MenuTrigger>
    </ModalContext.Provider>
  );
}

type PressableChild = React.ComponentProps<typeof Pressable>["children"];

/**
 * The control that opens the menu. `asChild` lends the menu a control the caller
 * renders, which must pass its props and ref through to a focusable element.
 */
function DropdownMenuTrigger({
  asChild = false,
  children,
  ...props
}: ButtonProps & { asChild?: boolean; children: React.ReactNode }) {
  if (!asChild) return <AriaButton {...props}>{children}</AriaButton>;
  const child = children as React.ReactElement<{ disabled?: boolean }>;
  return <Pressable isDisabled={child.props.disabled}>{child as PressableChild}</Pressable>;
}

type Align = "start" | "end";

function MenuSurface({
  placement,
  offset,
  label,
  className,
  testId,
  modal,
  triggerRef,
  menuRef,
  autoFocus,
  isOpen,
  onOpenChange,
  onClose,
  onClosed,
  children,
}: {
  placement: Placement;
  offset: number;
  label?: string;
  className?: string;
  testId?: string;
  modal: boolean;
  triggerRef?: React.RefObject<Element | null>;
  menuRef?: React.Ref<HTMLDivElement>;
  /** A menu without a trigger takes focus itself; a trigger's menu is focused by the trigger. */
  autoFocus?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onClose?: () => void;
  onClosed?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Popover
      className={cn("menu-surface enter-fade-fast", className)}
      style={LAYER_STYLE}
      placement={placement}
      offset={offset}
      isNonModal={!modal}
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      {onClosed && <ClosedHook onClosed={onClosed} />}
      <Menu
        ref={menuRef}
        autoFocus={autoFocus ? "first" : undefined}
        className="menu-list"
        aria-label={label}
        data-testid={testId}
        onClose={onClose}
      >
        {children}
      </Menu>
    </Popover>
  );
}

/** Runs once the menu is gone and anything its action opened has taken focus. */
function ClosedHook({ onClosed }: { onClosed: () => void }) {
  const latest = React.useRef(onClosed);
  latest.current = onClosed;
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A hook mounted again by then was only remounted, as StrictMode does.
      afterArrivals(() => {
        if (!mounted.current) latest.current();
      });
    };
  }, []);
  return null;
}

function DropdownMenuContent({
  align = "start",
  sideOffset = 6,
  className,
  "aria-label": label,
  "data-testid": testId,
  children,
}: {
  align?: Align;
  sideOffset?: number;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  children: React.ReactNode;
}) {
  const modal = React.useContext(ModalContext);
  return (
    <MenuSurface
      placement={`bottom ${align}`}
      offset={sideOffset}
      label={label}
      className={className}
      testId={testId}
      modal={modal}
    >
      {children}
    </MenuSurface>
  );
}

/**
 * A menu summoned at a point — a context menu, or a gesture on a row — rather
 * than from a control of its own. Focus has no trigger to return to, so the
 * caller says where it goes once the menu is gone.
 */
function PointMenu({
  at,
  label,
  owner,
  onClose,
  onClosed = () => restoreOverlayFocus(null, owner()),
  children,
}: {
  at: { x: number; y: number } | null;
  label: string;
  /** Where focus belongs once the menu is gone, and the owner of any dialog it opens. */
  owner: () => HTMLElement | null;
  onClose: () => void;
  onClosed?: () => void;
  children: React.ReactNode;
}) {
  const anchor = React.useRef<HTMLSpanElement>(null);
  return (
    <>
      <span
        ref={anchor}
        className="menu-anchor"
        aria-hidden
        style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
      />
      <MenuSurface
        placement="bottom start"
        offset={6}
        label={label}
        modal={false}
        triggerRef={anchor}
        isOpen={at !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        menuRef={menuOwnerRef(owner)}
        autoFocus
        onClose={onClose}
        onClosed={onClosed}
      >
        {children}
      </MenuSurface>
    </>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  disabled,
  onSelect,
  ...props
}: Omit<MenuItemProps, "className" | "isDisabled" | "onAction"> & {
  className?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  onSelect?: () => void;
  "data-testid"?: string;
}) {
  return (
    <MenuItem
      className={cn("menu-row", className)}
      data-variant={variant}
      isDisabled={disabled}
      onAction={onSelect}
      {...props}
    />
  );
}

/** A section of a menu, headed when it has a label. */
function DropdownMenuGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <MenuSection>
      {label !== undefined && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
      {children}
    </MenuSection>
  );
}

/**
 * Choices within a group — the rows a `<select>`'s options become now that
 * every list of choices in the product opens the same menu.
 */
function DropdownMenuRadioGroup({
  label,
  value,
  onValueChange,
  children,
}: {
  label?: string;
  value: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <MenuSection
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [key] = keys === "all" ? [] : [...keys];
        if (key !== undefined) onValueChange?.(String(key));
      }}
    >
      {label !== undefined && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
      {children}
    </MenuSection>
  );
}

/**
 * Switches within a group — each one state the reader turns on or off, as
 * against a radio group's one-of-many.
 */
function DropdownMenuCheckboxGroup({
  label,
  checked,
  onCheckedChange,
  children,
}: {
  label?: string;
  checked: readonly string[];
  onCheckedChange: (value: string, checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <MenuSection
      selectionMode="multiple"
      selectedKeys={checked}
      onSelectionChange={(keys) => {
        if (keys === "all") return;
        const next = new Set([...keys].map(String));
        for (const value of next) if (!checked.includes(value)) onCheckedChange(value, true);
        for (const value of checked) if (!next.has(value)) onCheckedChange(value, false);
      }}
    >
      {label !== undefined && <DropdownMenuLabel>{label}</DropdownMenuLabel>}
      {children}
    </MenuSection>
  );
}

/**
 * One choice in a radio or checkbox group. It reserves the indicator's column
 * whether or not it is chosen, so a menu does not shift its text sideways as the
 * selection moves down it, and a menu mixing both kinds keeps one left edge.
 */
function DropdownMenuChoice({
  value,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuItem>, "id" | "value" | "children"> & {
  value: Key;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem id={value} className={cn("menu-choice", className)} {...props}>
      {({ isSelected }) => (
        <>
          <span className="menu-indicator">{isSelected && <CheckIcon aria-hidden />}</span>
          {children}
        </>
      )}
    </DropdownMenuItem>
  );
}

/**
 * The heading over a section of a menu. It takes `.group-label`, which is the
 * product's one group-divider rule (designs/foundations.md § Typography): four
 * signals in agreement — smaller, heavier, tracked out, a step quieter — because
 * one step of anything reads as the first item of its own list rather than as
 * its heading. No menu is allowed to invent its own.
 */
function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <Header className="group-label flex min-h-[24px] items-center px-2 pt-1">{children}</Header>
  );
}

function DropdownMenuSeparator() {
  return <Separator className="-mx-1 my-1 h-px border-0 bg-border" />;
}

/**
 * The shortcut column. Every menu item that has a keyboard binding shows it
 * here — one of the five surfaces that teach the command layer, and the reason
 * a hover-revealed control is discoverable rather than hidden.
 *
 * It holds a `<Kbd>`, which owns how a modifier and its key are set (app.css
 * § .kbd); this element contributes position only.
 */
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("ml-auto flex items-center pl-4", className)} {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuCheckboxGroup,
  DropdownMenuChoice,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  PointMenu,
};
