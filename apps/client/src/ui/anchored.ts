// Shared anchor vocabulary for every contextual panel. Geometry says where a
// panel belongs; the owner says where focus returns. Keeping them separate lets
// a captured point or caret survive reconciliation without pretending its box
// is a focusable DOM element.

import { textareaCaretRect } from "./textarea-caret";

export type AnchorGeometry =
  | { kind: "element"; element: HTMLElement }
  | { kind: "caret"; textarea: HTMLTextAreaElement; offset: number }
  | { kind: "point"; clientX: number; clientY: number }
  | { kind: "rect"; rect: DOMRectReadOnly };

export interface OverlayAnchor {
  geometry: AnchorGeometry;
  owner: HTMLElement | null;
}

export type Anchor = OverlayAnchor | null;

export interface AnchoredOptions {
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  gap?: number;
}

function hasArea(rect: DOMRectReadOnly | null): rect is DOMRectReadOnly {
  return rect !== null && (rect.width > 0 || rect.height > 0);
}

export function elementAnchor(element: HTMLElement | null): Anchor {
  return element === null ? null : { geometry: { kind: "element", element }, owner: element };
}

export function caretAnchor(textarea: HTMLTextAreaElement, offset: number): OverlayAnchor {
  return { geometry: { kind: "caret", textarea, offset }, owner: textarea };
}

export function pointAnchor(
  clientX: number,
  clientY: number,
  owner: HTMLElement | null = null,
): OverlayAnchor {
  return { geometry: { kind: "point", clientX, clientY }, owner };
}

export function rectAnchor(rect: DOMRectReadOnly, owner: HTMLElement | null = null): OverlayAnchor {
  return { geometry: { kind: "rect", rect }, owner };
}

/** The live element whose movement should reposition the panel. */
export function anchorElement(anchor: Anchor): HTMLElement | null {
  if (anchor === null) return null;
  if (anchor.geometry.kind === "element") return anchor.geometry.element;
  if (anchor.geometry.kind === "caret") return anchor.geometry.textarea;
  return null;
}

export function measureAnchor(anchor: Anchor): DOMRectReadOnly | null {
  if (anchor === null) return null;
  const { geometry } = anchor;
  if (geometry.kind === "rect") return hasArea(geometry.rect) ? geometry.rect : null;
  if (geometry.kind === "point") {
    return DOMRect.fromRect({
      x: geometry.clientX,
      y: geometry.clientY,
      width: 1,
      height: 1,
    });
  }
  if (geometry.kind === "caret") return textareaCaretRect(geometry.textarea, geometry.offset);
  if (!geometry.element.isConnected) return null;
  const rect = geometry.element.getBoundingClientRect();
  return hasArea(rect) ? rect : null;
}

/** Captures viewport geometry while retaining the focus owner of the gesture. */
export function snapshotAnchor(anchor: Anchor): Anchor {
  const rect = measureAnchor(anchor);
  return rect ? rectAnchor(rect, anchor?.owner ?? null) : null;
}
