// A panel that belongs to a control.
//
// Property editing, query ordering and column visibility are richer than menus:
// their rows hold controls of their own. React Aria owns the common interaction
// contract — measured collision placement and the overlay stack that decides
// which layer an outside press dismisses — while this component owns the rest of
// a panel's manners and callers own only their rows.
//
// Escape is answered from the inside out. A layer summoned from within the
// panel is portaled into it (§ ui/overlay-root), so its keydown reaches the
// panel only if that layer left it alone; a panel whose anchor keeps focus — a
// combobox — hears Escape on the anchor itself, before any surface around it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FocusScope, useOverlay, useOverlayPosition, type Placement } from "react-aria";
import { anchorElement, measureAnchor, type Anchor, type AnchoredOptions } from "./anchored";
import { OverlayRoot, useOverlayRoot } from "./overlay-root";
import {
  afterArrivals,
  afterCommit,
  firstTabbable,
  restoreOverlayFocus,
  vetoable,
  type PanelEvent,
} from "./overlay-focus";

const VIEWPORT_INSET = 12;

type AnchorSource = Anchor | (() => Anchor);

function resolveAnchor(source: AnchorSource): Anchor {
  return typeof source === "function" ? source() : source;
}

export function AnchoredPanel({
  anchor,
  label,
  id,
  role = "dialog",
  className,
  options = {},
  revision,
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
  /** Content whose change can resize the panel; placement is recomputed with it. */
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
  onEscapeKeyDown?: (event: PanelEvent) => void;
  /** Prevent the event to keep the panel open while focus works elsewhere. */
  onFocusOutside?: (event: PanelEvent) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useOverlayRoot();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const lastValid = useRef<DOMRectReadOnly | null>(null);
  const liveElement = anchorElement(resolveAnchor(anchor));
  const latest = useRef({ anchor, onClose, onEscapeKeyDown, onFocusOutside, returnFocus });
  latest.current = { anchor, onClose, onEscapeKeyDown, onFocusOutside, returnFocus };

  const rememberSurface = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      setSurface(node);
      if (surfaceRef) surfaceRef.current = node;
    },
    [surfaceRef],
  );

  /** The anchor's rectangle now, or where it last was while it is between renders. */
  const anchorRect = useCallback((): DOMRect => {
    const current = measureAnchor(resolveAnchor(latest.current.anchor));
    if (current) lastValid.current = current;
    return DOMRect.fromRect(
      lastValid.current ?? { x: window.innerWidth / 2, y: VIEWPORT_INSET, width: 0, height: 0 },
    );
  }, []);
  const rect = anchorRect();
  const extent = options.width ?? options.maxWidth ?? window.innerWidth - VIEWPORT_INSET * 2;
  const pointLike = !options.matchAnchorWidth && rect.width < extent;
  const align = pointLike && (rect.left + rect.right) / 2 > window.innerWidth / 2 ? "end" : "start";
  const placement = `${options.side ?? "bottom"} ${align}` as Placement;

  // The geometry comes from the anchor's own rectangle; the element only lends
  // React Aria a node to measure against.
  const targetRef = useRef<Element | null>(null);
  targetRef.current = liveElement ?? root;
  const { overlayProps: positionProps, updatePosition } = useOverlayPosition({
    targetRef,
    overlayRef: panelRef,
    placement,
    offset: options.gap ?? 4,
    containerPadding: VIEWPORT_INSET,
    shouldFlip: true,
    isOpen: true,
    maxHeight: options.maxHeight,
    getTargetRect: () => anchorRect(),
  });

  const { overlayProps } = useOverlay(
    {
      isOpen: true,
      onClose,
      isDismissable: true,
      // Escape has the panel's own handling below.
      isKeyboardDismissDisabled: true,
      // A virtual anchor is not a DOM ancestor of the panel, so a press on it
      // would otherwise be outside. The anchor owns that gesture: dismissing
      // first could detach the pressed control before its click toggles or
      // retargets the panel.
      shouldCloseOnInteractOutside: (element) =>
        !anchorElement(resolveAnchor(latest.current.anchor))?.contains(element),
    },
    panelRef,
  );

  const escape = useCallback((event: Event) => {
    const veto = vetoable();
    latest.current.onEscapeKeyDown?.(veto);
    event.preventDefault();
    if (!veto.defaultPrevented) latest.current.onClose();
  }, []);

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    escape(event.nativeEvent);
  };

  useEffect(() => {
    if (!preserveAnchorFocus || !liveElement) return;
    // Registered on the anchor itself, so it runs before the keydown bubbles to
    // a surface the anchor sits in.
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      escape(event);
    };
    liveElement.addEventListener("keydown", listener);
    return () => liveElement.removeEventListener("keydown", listener);
  }, [escape, liveElement, preserveAnchorFocus]);

  useEffect(() => {
    if (!surface) return;
    const left = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || surface.contains(next)) return;
      if (anchorElement(resolveAnchor(latest.current.anchor))?.contains(next)) return;
      const veto = vetoable();
      latest.current.onFocusOutside?.(veto);
      if (!veto.defaultPrevented && !preserveAnchorFocus) latest.current.onClose();
    };
    surface.addEventListener("focusout", left);
    return () => surface.removeEventListener("focusout", left);
  }, [preserveAnchorFocus, surface]);

  // Arrival: a field that claimed focus as it mounted, else the caller's field,
  // else the first control, else the panel itself. A combobox keeps the caret
  // where the reader is typing.
  useLayoutEffect(() => {
    if (!surface || preserveAnchorFocus) return;
    afterCommit(() => {
      if (!surface.isConnected || surface.contains(document.activeElement)) return;
      const target = initialFocus?.() ?? firstTabbable(surface) ?? surface;
      target.focus({ preventScroll: true });
    });
    // Arrival only: later renders must not move focus.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  // Departure: focus left inside the panel, or dropped onto the page, returns to
  // its owner; focus an action already moved elsewhere stays where it went.
  useLayoutEffect(() => {
    if (!surface) return;
    return () => {
      const { returnFocus: resolve, anchor: current } = latest.current;
      const owner = resolve?.() ?? resolveAnchor(current)?.owner ?? null;
      afterArrivals(() => {
        if (!surface.isConnected) restoreOverlayFocus(surface, owner);
      });
    };
  }, [surface]);

  useLayoutEffect(() => {
    if (!liveElement) return;
    const closeIfDetached = () => {
      const current = anchorElement(resolveAnchor(latest.current.anchor));
      if (current && !current.isConnected) latest.current.onClose();
    };
    closeIfDetached();
    const observer = new MutationObserver(closeIfDetached);
    observer.observe(liveElement.ownerDocument, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [liveElement]);

  // The panel follows its anchor through scrolling and through its own resizes.
  useEffect(() => {
    if (dismissOnExternalScroll) {
      const dismiss = (event: Event) => {
        const target = event.target;
        if (target instanceof Node && surface?.contains(target)) return;
        if (target instanceof Node && liveElement?.contains(target)) return;
        latest.current.onClose();
      };
      window.addEventListener("scroll", dismiss, true);
      return () => window.removeEventListener("scroll", dismiss, true);
    }
    window.addEventListener("scroll", updatePosition, true);
    return () => window.removeEventListener("scroll", updatePosition, true);
  }, [dismissOnExternalScroll, liveElement, surface, updatePosition]);
  useLayoutEffect(() => {
    updatePosition();
  }, [revision, updatePosition]);

  // React Aria lifts its overlays to one fixed z-index; the panel's own class
  // places it in the product's layer order instead.
  const { zIndex: _zIndex, ...position } = positionProps.style ?? {};
  const style: CSSProperties = { ...position, ...panelStyle(options, rect) };
  const panel = (
    <div
      {...overlayProps}
      ref={rememberSurface}
      id={id}
      className={className}
      role={role}
      aria-label={label}
      aria-modal={trapFocus || undefined}
      tabIndex={-1}
      style={style}
      data-testid={testId}
      onKeyDown={onSurfaceKeyDown}
    >
      <OverlayRoot node={surface}>{children}</OverlayRoot>
    </div>
  );
  return createPortal(
    trapFocus ? (
      <>
        {/* Nothing behind a contained panel takes a press meant to dismiss it. */}
        <div className="anchored-panel-underlay" aria-hidden />
        <FocusScope contain>{panel}</FocusScope>
      </>
    ) : (
      panel
    ),
    root,
  );
}

function panelStyle(options: AnchoredOptions, anchor: DOMRect): CSSProperties {
  const availableWidth = `calc(100vw - ${VIEWPORT_INSET * 2}px)`;
  const minWidth = options.matchAnchorWidth
    ? Math.max(options.minWidth ?? 0, anchor.width)
    : options.minWidth;
  return {
    pointerEvents: "auto",
    width: options.width,
    minWidth,
    maxWidth:
      options.maxWidth === undefined
        ? availableWidth
        : `min(${options.maxWidth}px, ${availableWidth})`,
  };
}
