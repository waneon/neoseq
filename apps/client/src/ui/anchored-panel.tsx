// A panel that belongs to a control.
//
// Property editing, query ordering and column visibility are richer than menus:
// their rows hold controls of their own. Radix Popover owns the common
// interaction contract — measured collision placement, focus movement and
// looping, outside dismissal, Escape, and restoration — while callers own only
// their rows.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { snapshotAnchor, type Anchor, type AnchoredOptions } from "./anchored";
import { OverlayRoot, useOverlayRoot } from "./overlay-root";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverPortal,
} from "./shadcn/popover";

const VIEWPORT_INSET = 12;

interface Measurable {
  getBoundingClientRect(): DOMRect;
}

function measurableAnchor(anchor: Anchor): Measurable {
  let lastValid = snapshotAnchor(anchor);
  return {
    getBoundingClientRect: () => {
      const current = snapshotAnchor(anchor);
      if (current) lastValid = current;
      return lastValid ?? DOMRect.fromRect({
        x: window.innerWidth / 2,
        y: VIEWPORT_INSET,
      });
    },
  };
}

function panelStyle(options: AnchoredOptions): CSSProperties {
  const availableWidth = `calc(100vw - ${VIEWPORT_INSET * 2}px)`;
  return {
    pointerEvents: "auto",
    width: options.width,
    minWidth: options.matchAnchorWidth
      ? options.minWidth === undefined
        ? "var(--radix-popover-trigger-width)"
        : `max(${options.minWidth}px, var(--radix-popover-trigger-width))`
      : options.minWidth,
    maxWidth: options.maxWidth === undefined
      ? availableWidth
      : `min(${options.maxWidth}px, ${availableWidth})`,
    maxHeight: options.maxHeight === undefined
      ? "var(--radix-popover-content-available-height)"
      : `min(${options.maxHeight}px, var(--radix-popover-content-available-height))`,
  };
}

export function AnchoredPanel({
  anchor,
  label,
  id,
  role = "dialog",
  className,
  options = {},
  revision: _revision,
  testId,
  surfaceRef,
  dismissOnExternalScroll = false,
  trapFocus = false,
  preserveAnchorFocus = false,
  initialFocus,
  onEscapeKeyDown,
  onFocusOutside,
  onKeyDown,
  onClose,
  children,
}: {
  /** The control the panel hangs off; Escape gives it focus back. */
  anchor: Anchor;
  label: string;
  id?: string;
  role?: "dialog" | "listbox";
  className: string;
  options?: AnchoredOptions;
  /** Content changes are observed by Radix and cause placement to be recomputed. */
  revision?: unknown;
  testId?: string;
  /** Gives a richer panel access to its own focusable surface. */
  surfaceRef?: RefObject<HTMLDivElement | null>;
  /** The panel belongs to its anchor's current viewport, not to a later scroll position. */
  dismissOnExternalScroll?: boolean;
  /** Dialog-like editors contain Tab and move focus to their first useful field. */
  trapFocus?: boolean;
  /** Combobox lists leave the caret in their anchor while options are active descendants. */
  preserveAnchorFocus?: boolean;
  initialFocus?: () => HTMLElement | null;
  /** Prevent the event to keep the panel open, as a staged editor does on its way back. */
  onEscapeKeyDown?: ComponentProps<typeof PopoverContent>["onEscapeKeyDown"];
  onFocusOutside?: ComponentProps<typeof PopoverContent>["onFocusOutside"];
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useOverlayRoot();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const escaped = useRef(false);
  const virtualRef = useMemo(
    () => ({ current: measurableAnchor(anchor) }),
    [anchor],
  );
  const rememberSurface = useCallback((node: HTMLDivElement | null) => {
    setSurface(node);
    if (surfaceRef) surfaceRef.current = node;
  }, [surfaceRef]);
  const rect = virtualRef.current.getBoundingClientRect();
  const extent = options.width ?? options.maxWidth ?? window.innerWidth - VIEWPORT_INSET * 2;
  const pointLike = !options.matchAnchorWidth && rect.width < extent;
  const align = pointLike && (rect.left + rect.right) / 2 > window.innerWidth / 2
    ? "end"
    : "start";

  useEffect(() => {
    if (!dismissOnExternalScroll) return;
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && surface?.contains(target)) return;
      if (target instanceof Node && anchor instanceof HTMLElement && anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("scroll", dismiss, true);
    return () => window.removeEventListener("scroll", dismiss, true);
  }, [anchor, dismissOnExternalScroll, onClose, surface]);

  return (
    <Popover open modal={trapFocus} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverPortal container={root}>
        <PopoverContent
          ref={rememberSurface}
          id={id}
          className={className}
          role={role}
          aria-label={label}
          align={align}
          side="bottom"
          sideOffset={options.gap ?? 4}
          collisionPadding={VIEWPORT_INSET}
          sticky="always"
          style={panelStyle(options)}
          data-testid={testId}
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event);
            if (!event.defaultPrevented) escaped.current = true;
          }}
          onOpenAutoFocus={(event) => {
            if (preserveAnchorFocus) {
              event.preventDefault();
              return;
            }
            if (!initialFocus) return;
            event.preventDefault();
            queueMicrotask(() => initialFocus()?.focus({ preventScroll: true }));
          }}
          onFocusOutside={(event) => {
            onFocusOutside?.(event);
            // A combobox expresses focus through aria-activedescendant: DOM
            // focus intentionally stays in the anchor, and its small blur
            // grace period owns pointer handoff and stale-focus cancellation.
            if (preserveAnchorFocus) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            const target = event.detail.originalEvent.target;
            // A virtual anchor is not a DOM ancestor of the content, so Radix
            // otherwise calls it "outside" and removes the panel on pointerdown.
            // That can detach the pressed control before its click gets to
            // toggle or retarget the panel. The anchor owns that gesture.
            if (
              target instanceof Node
              && anchor instanceof HTMLElement
              && anchor.contains(target)
            ) event.preventDefault();
          }}
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (escaped.current && anchor instanceof HTMLElement) {
              anchor.focus({ preventScroll: true });
            }
          }}
        >
          <OverlayRoot node={surface}>{children}</OverlayRoot>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
