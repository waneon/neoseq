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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { anchorElement, measureAnchor, type Anchor, type AnchoredOptions } from "./anchored";
import { OverlayRoot, useOverlayRoot } from "./overlay-root";
import { restoreOverlayFocus } from "./overlay-focus";
import { Popover, PopoverAnchor, PopoverContent, PopoverPortal } from "./shadcn/popover";

const VIEWPORT_INSET = 12;

interface Measurable {
  getBoundingClientRect(): DOMRect;
  contextElement?: Element;
}

type AnchorSource = Anchor | (() => Anchor);

function resolveAnchor(source: AnchorSource): Anchor {
  return typeof source === "function" ? source() : source;
}

function measurableAnchor(
  anchor: AnchorSource,
  lastValid: { current: DOMRectReadOnly | null },
): Measurable {
  const initial = measureAnchor(resolveAnchor(anchor));
  if (initial) lastValid.current = initial;
  return {
    get contextElement() {
      return anchorElement(resolveAnchor(anchor)) ?? undefined;
    },
    getBoundingClientRect: () => {
      const current = measureAnchor(resolveAnchor(anchor));
      if (current) lastValid.current = current;
      const rect =
        lastValid.current ??
        DOMRect.fromRect({
          x: window.innerWidth / 2,
          y: VIEWPORT_INSET,
        });
      return DOMRect.fromRect(rect);
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
    maxWidth:
      options.maxWidth === undefined
        ? availableWidth
        : `min(${options.maxWidth}px, ${availableWidth})`,
    maxHeight:
      options.maxHeight === undefined
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
  returnFocus,
  onEscapeKeyDown,
  onFocusOutside,
  onKeyDown,
  onClose,
  children,
}: {
  /** The control the panel hangs off and returns focus to after an inside action. */
  anchor: AnchorSource;
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
  /** Resolves a persistent owner when a command removes the invoking control. */
  returnFocus?: () => HTMLElement | null;
  /** Prevent the event to keep the panel open, as a staged editor does on its way back. */
  onEscapeKeyDown?: ComponentProps<typeof PopoverContent>["onEscapeKeyDown"];
  onFocusOutside?: ComponentProps<typeof PopoverContent>["onFocusOutside"];
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useOverlayRoot();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const lastValid = useRef<DOMRectReadOnly | null>(null);
  const liveElement = anchorElement(resolveAnchor(anchor));
  const virtualRef = useMemo(() => ({ current: measurableAnchor(anchor, lastValid) }), [anchor]);
  const rememberSurface = useCallback(
    (node: HTMLDivElement | null) => {
      setSurface(node);
      if (surfaceRef) surfaceRef.current = node;
    },
    [surfaceRef],
  );
  const rect = virtualRef.current.getBoundingClientRect();
  const extent = options.width ?? options.maxWidth ?? window.innerWidth - VIEWPORT_INSET * 2;
  const pointLike = !options.matchAnchorWidth && rect.width < extent;
  const align = pointLike && (rect.left + rect.right) / 2 > window.innerWidth / 2 ? "end" : "start";

  useLayoutEffect(() => {
    if (!liveElement) return;
    const closeIfDetached = () => {
      const current = anchorElement(resolveAnchor(anchor));
      if (current && !current.isConnected) onClose();
    };
    closeIfDetached();
    const observer = new MutationObserver(closeIfDetached);
    observer.observe(liveElement.ownerDocument, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [anchor, liveElement, onClose]);

  useEffect(() => {
    if (!dismissOnExternalScroll) return;
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && surface?.contains(target)) return;
      if (target instanceof Node && liveElement?.contains(target)) return;
      onClose();
    };
    window.addEventListener("scroll", dismiss, true);
    return () => window.removeEventListener("scroll", dismiss, true);
  }, [dismissOnExternalScroll, liveElement, onClose, surface]);

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
          side={options.side ?? "bottom"}
          sideOffset={options.gap ?? 4}
          collisionPadding={VIEWPORT_INSET}
          sticky="always"
          style={panelStyle(options)}
          data-testid={testId}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            if (preserveAnchorFocus) {
              event.preventDefault();
              return;
            }
            if (!initialFocus) return;
            event.preventDefault();
            initialFocus()?.focus({ preventScroll: true });
          }}
          onFocusOutside={(event) => {
            onFocusOutside?.(event);
            // A combobox expresses focus through aria-activedescendant: DOM
            // focus intentionally stays in the anchor. Pointer and focus
            // ownership determine handoff without a delayed blur dismissal.
            if (preserveAnchorFocus) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            const target = event.detail.originalEvent.target;
            // A virtual anchor is not a DOM ancestor of the content, so Radix
            // otherwise calls it "outside" and removes the panel on pointerdown.
            // That can detach the pressed control before its click gets to
            // toggle or retarget the panel. The anchor owns that gesture.
            if (target instanceof Node && anchorElement(resolveAnchor(anchor))?.contains(target))
              event.preventDefault();
          }}
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) =>
            restoreOverlayFocus(event, returnFocus?.() ?? resolveAnchor(anchor)?.owner ?? null)
          }
        >
          <OverlayRoot node={surface}>{children}</OverlayRoot>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
