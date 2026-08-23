// A panel that belongs to a control.
//
// Some choices are too wide for a menu. A menu row holds one thing a reader can
// press; an order term holds a name, a direction, two moves and a removal, and a
// column holds a switch and a summary. Those are *panels* — floating surfaces at
// depth level 2 — and the product has more than one of them.
//
// What every one of them owes the reader is identical: it opens against the
// control that summoned it, it dismisses on an outside press, on `⎋`, and on
// choosing; `⎋` hands focus back to where the press came from; and `⇥` stays
// inside it while it is up. That is this file. What is left for a caller is the
// only part that differs — the rows.
//
// The one exception worth stating: the product's dropdown (`ui/menu-select`)
// portals to the body, so a press on one of its rows lands *outside* this panel
// in the DOM while being, to the reader, a press inside the editor they are
// filling in. Such a press is not an outside press.

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type Anchor, type AnchoredOptions } from "./anchored";

/** What `⇥` cycles through, and what opening the panel puts the caret on. */
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),[role="button"]';

export function AnchoredPanel({
  anchor,
  label,
  className,
  options,
  revision,
  testId,
  onClose,
  children,
}: {
  /** The control the panel hangs off; `⎋` gives it its focus back. */
  anchor: Anchor;
  /** The surface's accessible name. */
  label: string;
  className: string;
  options?: AnchoredOptions;
  /** Re-places the panel when the caller's own content changed size. */
  revision?: unknown;
  testId?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(anchor, options, revision);
  // Callers write `onClose` inline, so the listeners read it through a ref
  // rather than being torn down and re-armed on every render of the panel.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (panelRef.current?.contains(node)) return;
      if (anchor instanceof HTMLElement && anchor.contains(node)) return;
      if (node instanceof Element && node.closest('[data-slot="dropdown-menu-content"]')) return;
      closeRef.current();
    };
    // Armed after the press that opened the panel has finished travelling.
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", closeOnOutsidePress, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
    };
  }, [anchor]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return createPortal(
    <div
      ref={panelRef}
      className={className}
      // Placement is inline because it is measured, and so is this: a portal
      // lands on the body, which is exactly where a modal dialog writes
      // `pointer-events: none` to make the page behind it inert. A panel the
      // dialog itself summoned is not the page behind it.
      style={{ ...position, pointerEvents: "auto" }}
      role="dialog"
      aria-label={label}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          if (anchor instanceof HTMLElement) anchor.focus({ preventScroll: true });
          closeRef.current();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
