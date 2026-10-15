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
// against the window — see designs/foundations.md § Motion.

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { UNSAFE_PortalProvider } from "react-aria";

const OverlayRootContext = createContext<HTMLElement | null>(null);

/**
 * Declares this subtree's summoned surfaces to belong to `node`, both the
 * product's own panels and the menus and lists React Aria portals.
 */
export function OverlayRoot({ node, children }: { node: HTMLElement | null; children: ReactNode }) {
  const getContainer = useCallback(() => node ?? document.body, [node]);
  return (
    <OverlayRootContext.Provider value={node}>
      <UNSAFE_PortalProvider getContainer={getContainer}>{children}</UNSAFE_PortalProvider>
    </OverlayRootContext.Provider>
  );
}

/**
 * The element a summoned surface portals into: the modal surface around it, or
 * the page itself.
 */
export function useOverlayRoot(): HTMLElement {
  return useContext(OverlayRootContext) ?? document.body;
}

/**
 * React Aria lifts its overlays to one fixed z-index; a surface's class places
 * it in the product's layer order instead.
 */
export const LAYER_STYLE = { zIndex: undefined };
