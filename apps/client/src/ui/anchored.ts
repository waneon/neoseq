// Shared anchor vocabulary for every contextual panel. Placement and collision
// handling belong to `AnchoredPanel`; callers may hand it either a live control
// or the last measurable box of a control that reconciliation will replace.

export type Anchor = HTMLElement | DOMRect | null;

export interface AnchoredOptions {
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  gap?: number;
}

function hasArea(rect: DOMRect | null): rect is DOMRect {
  return rect !== null && (rect.width > 0 || rect.height > 0);
}

/** A stable viewport-space box, or null when an element cannot be measured. */
export function snapshotAnchor(anchor: Anchor): DOMRect | null {
  if (anchor === null) return null;
  if (!(anchor instanceof HTMLElement)) return hasArea(anchor) ? anchor : null;
  if (!anchor.isConnected) return null;
  const rect = anchor.getBoundingClientRect();
  return hasArea(rect) ? rect : null;
}
