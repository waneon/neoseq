// A modal layer.
//
// React Aria owns the modal contract — the overlay stack that decides which
// layer an outside press dismisses, the scroll lock, and an inert page behind —
// while this component owns arrival and departure focus and Escape.
//
// The frame is the underlay: everything outside it is made inert, so the scrim
// is its `::before` rather than a sibling, which would be inert too. Opacity on
// the frame itself would fade the panel with it.
//
// Escape is answered from the inside out. A field holding a draft, or a layer
// summoned within the modal (§ ui/overlay-root), sees the key first; the modal
// closes only if none of them claimed it.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FocusScope, useModalOverlay, usePreventScroll } from "react-aria";
import { OverlayRoot, useOverlayRoot } from "./overlay-root";
import {
  afterArrivals,
  afterCommit,
  currentFocusOwner,
  firstTabbable,
  restoreOverlayFocus,
} from "./overlay-focus";

export function ModalLayer({
  role = "dialog",
  frameClassName,
  className,
  testId,
  dismissible = true,
  initialFocus,
  returnFocus,
  onEscapeKeyDown,
  onKeyDown,
  onClose,
  onClosed,
  children,
  ...labelling
}: {
  role?: "dialog" | "alertdialog";
  frameClassName: string;
  className: string;
  testId?: string;
  /** A press outside the panel closes it. */
  dismissible?: boolean;
  initialFocus?: () => HTMLElement | null;
  /** Resolves a persistent owner when the invoking control is replaced or removed. */
  returnFocus?: () => HTMLElement | null;
  /** Prevent the event to keep the modal open. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onClose: () => void;
  /** Runs once focus has returned, after the modal no longer contains it. */
  onClosed?: () => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-busy"?: boolean;
  children: ReactNode;
}) {
  const root = useOverlayRoot();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [owner] = useState(currentFocusOwner);
  const latest = useRef({ onClose, onClosed, returnFocus });
  latest.current = { onClose, onClosed, returnFocus };

  // Mounted only while open; closing is the parent unmounting it.
  const state = useMemo(() => {
    const close = () => latest.current.onClose();
    const ignore = () => {};
    return {
      isOpen: true,
      setOpen: ignore,
      open: ignore,
      close,
      toggle: close,
      point: null,
      setPoint: ignore,
    };
  }, []);
  const { modalProps, underlayProps } = useModalOverlay(
    { isDismissable: dismissible, isKeyboardDismissDisabled: true },
    state,
    panelRef,
  );
  usePreventScroll();

  // Arrival: a field that claimed focus as it mounted, else the caller's
  // choice, else the first control, else the panel itself.
  useLayoutEffect(() => {
    if (!surface) return;
    afterCommit(() => {
      if (!surface.isConnected || surface.contains(document.activeElement)) return;
      const target = initialFocus?.() ?? firstTabbable(surface) ?? surface;
      target.focus({ preventScroll: true });
    });
    // Arrival only: later renders must not move focus.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  // Departure. A surface still in the document was only remounted, as
  // StrictMode does, and keeps its focus.
  useEffect(() => {
    if (!surface) return;
    return () => {
      const { returnFocus: resolve, onClosed: closed } = latest.current;
      const target = resolve?.() ?? owner;
      afterArrivals(() => {
        if (surface.isConnected) return;
        restoreOverlayFocus(surface, target);
        closed?.();
      });
    };
  }, [owner, surface]);

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    // The native event's flag is live; the synthetic copy is not.
    const native = event.nativeEvent;
    if (event.key !== "Escape" || native.defaultPrevented) return;
    event.stopPropagation();
    onEscapeKeyDown?.(native);
    const kept = native.defaultPrevented;
    event.preventDefault();
    if (!kept) onClose();
  };

  return createPortal(
    <div {...underlayProps} className={frameClassName} data-testid={testId}>
      <FocusScope contain>
        <div
          {...modalProps}
          {...labelling}
          ref={(node) => {
            panelRef.current = node;
            setSurface(node);
          }}
          className={className}
          role={role}
          aria-modal="true"
          tabIndex={-1}
          onKeyDown={onSurfaceKeyDown}
        >
          <OverlayRoot node={surface}>{children}</OverlayRoot>
        </div>
      </FocusScope>
    </div>,
    root,
  );
}
