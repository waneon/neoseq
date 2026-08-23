// Where a summoned surface lands.
//
// Every floating surface in the product is portaled out of its own subtree: a
// panel, a menu, an autocomplete list. That is not decoration — it is what lets
// them escape the outline's scroll container, its clipping, and the
// virtualizer's transformed stacking context (§ ui/anchored). The destination
// was `document.body`, and for a surface summoned from the page that is exactly
// right.
//
// It is exactly wrong under a modal dialog, because a modal is not a z-index.
// The dialog holds three things at once: a scroll lock that cancels every wheel
// raised outside it, `pointer-events: none` on the body so the page behind is
// inert, and a focus trap that hands focus back the moment it leaves. A surface
// parked on the body is outside all three, and each one broke it a different
// way — a columns panel that drew a scrollbar and refused to scroll, a page
// autocomplete whose rows no pointer could reach, a panel that gave its focus
// straight back to the control that summoned it.
//
// So a surface lands *in the modal it was summoned from*, and on the body only
// when there is none. One rule, and every summoned surface keeps whatever
// guarantees the surface around it already has. What it asks of a host in
// return is that it be a place a `position: fixed` child can still be placed
// against the window — see § Motion / An arrival lets go once it has landed.

import { createContext, useContext, type ReactNode } from "react";

const OverlayRootContext = createContext<HTMLElement | null>(null);

/** Declares this subtree's summoned surfaces to belong to `node`. */
export function OverlayRoot({
  node,
  children,
}: {
  node: HTMLElement | null;
  children: ReactNode;
}) {
  return <OverlayRootContext.Provider value={node}>{children}</OverlayRootContext.Provider>;
}

/**
 * The element a summoned surface portals into: the modal surface around it, or
 * the page itself.
 */
export function useOverlayRoot(): HTMLElement {
  return useContext(OverlayRootContext) ?? document.body;
}
