// Where a panel opens when it belongs to something on screen.
//
// Every summoned surface in the product — the slash menu, the tag menu, the
// property picker, the tag picker, the entity autocomplete — hangs off an
// anchor: a caret's textarea, a chip, a cell, an input. v1 gave each of them its
// own three lines of arithmetic with its own guessed panel height, and they all
// carried the same defect: the panel's top was clamped to `innerHeight - guess`,
// so a caret near the bottom of the window opened its menu *hundreds of pixels
// above itself*, over the text it was about to change.
//
// One placement rule replaces all of them, and it never needs to know how tall
// the panel is:
//
//   - Below the anchor is the preferred side, because that is where the reader
//     is already looking. The panel is pinned by its `top` and grows downward.
//   - When the room below cannot hold the panel and there is more room above,
//     the panel flips and is pinned by its `bottom` instead. A box anchored at
//     the bottom grows upward on its own, so this needs no measurement, no
//     second layout pass, and no first frame in the wrong place.
//   - Either way the returned `maxHeight` is the room actually available on the
//     chosen side, so a long list scrolls inside itself rather than off-screen.
//
// Sideways it is the same idea, and it was missing. Every panel was pinned by its
// `left` at the anchor's left edge and then shoved back inside the window if it
// did not fit, so a control near the right edge — a tag at the end of a line, the
// sort button at the end of a query's header — opened *away* from the writing and
// then slid back, landing at neither edge of the thing it belonged to. A panel
// opens toward the middle of the window now:
//
//   - A *point-like* anchor — one narrower than the panel: a chip, an icon
//     button, a mark — is a place, not a field. Its panel grows away from the
//     nearer window edge, pinned by `left` on the left half of the screen and by
//     `right` on the right half, and it flips back if the chosen side genuinely
//     cannot hold it.
//   - A *field-like* anchor — one at least as wide as the panel, or one the
//     caller asked to match — keeps its left edge, because the panel is standing
//     in for it: a combobox list that right-aligned under its own input, or a
//     slash menu that jumped to the far end of the line the caret is at the start
//     of, would be worse than anything this rule fixes.
//
// Placement is in viewport space throughout: these panels are portaled to the
// body precisely so they escape the outline's scroll container, its clipping,
// and the virtualizer's transformed stacking context.

import { useCallback, useLayoutEffect, useState, type CSSProperties } from "react";

/** Space kept between the panel and the window edge. */
const INSET = 12;
/** Space kept between the panel and its anchor. */
const GAP = 4;
/** No side is worth choosing below this: the panel would open as a sliver. */
const FLOOR = 128;

export interface AnchoredOptions {
  /** A fixed panel width. Omit for a panel that sizes to its content. */
  width?: number;
  /** The narrowest the panel may be. */
  minWidth?: number;
  /** The widest a content-sized panel may grow to. */
  maxWidth?: number;
  /** Take the anchor's own width as a floor, as a combobox list does. */
  matchAnchorWidth?: boolean;
  /** The tallest the panel wants to be, before available room caps it. */
  maxHeight?: number;
  /** Space between the panel and its anchor. */
  gap?: number;
}

/**
 * The fixed-position style for a panel hanging off `rect`. A null rect means the
 * anchor is gone (a remounted textarea, a removed chip); the panel then opens
 * near the top of the window instead of at the origin, which is where a 0×0
 * measurement used to put it.
 */
export function placeAnchored(rect: DOMRect | null, options: AnchoredOptions = {}): CSSProperties {
  const gap = options.gap ?? GAP;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const room = Math.max(0, viewportWidth - INSET * 2);

  const clamp = (value: number, floor: number) => Math.min(Math.max(value, floor), room);
  const floorWidth = Math.min(
    room,
    Math.max(options.minWidth ?? 0, options.matchAnchorWidth ? (rect?.width ?? 0) : 0),
  );
  const width = options.width === undefined ? undefined : clamp(options.width, floorWidth);
  const maxWidth = options.maxWidth === undefined ? undefined : clamp(options.maxWidth, floorWidth);
  // The widest the panel could end up, which is what keeps it inside the window.
  const extent = width ?? maxWidth ?? room;
  // Which edge the panel is pinned by. A field hands over its left edge; a mark
  // opens away from the window edge it is nearest, and gives that up only when
  // the side it wanted cannot hold the panel at all.
  const pointLike = rect !== null && !options.matchAnchorWidth && rect.width < extent;
  const wantsEnd = pointLike && (rect.left + rect.right) / 2 > viewportWidth / 2;
  const fitsEnd = rect !== null && rect.right - INSET >= extent;
  const fitsStart = rect !== null && viewportWidth - INSET - rect.left >= extent;
  const alignEnd = pointLike && (wantsEnd ? fitsEnd || !fitsStart : !fitsStart && fitsEnd);
  const desiredLeft = rect ? rect.left : (viewportWidth - extent) / 2;
  const left = Math.max(INSET, Math.min(desiredLeft, viewportWidth - extent - INSET));
  // Pinned by `right`, so the browser lines the panel's real edge up with the
  // anchor's — the same trick the vertical flip uses, and for the same reason: a
  // content-sized panel is narrower than `extent` and subtracting the guess would
  // leave it short of the edge it is meant to meet.
  const horizontal = alignEnd && rect
    ? { right: Math.max(INSET, viewportWidth - rect.right) }
    : { left };

  const wanted = options.maxHeight ?? viewportHeight;
  const anchorTop = rect ? rect.top : INSET + gap;
  const anchorBottom = rect ? rect.bottom : INSET;
  const below = viewportHeight - anchorBottom - gap - INSET;
  const above = anchorTop - gap - INSET;
  // Below unless it genuinely cannot serve: it holds what the panel wants, or it
  // is at least the roomier of the two sides.
  const flip = below < Math.min(wanted, FLOOR) && above > below;
  const size = {
    width,
    minWidth: floorWidth || undefined,
    maxWidth,
    maxHeight: Math.max(FLOOR, Math.min(wanted, flip ? above : below)),
  };

  return flip
    ? {
        position: "fixed",
        ...horizontal,
        bottom: Math.max(INSET, viewportHeight - anchorTop + gap),
        ...size,
      }
    : {
        position: "fixed",
        ...horizontal,
        top: Math.min(Math.max(INSET, anchorBottom + gap), viewportHeight - INSET - FLOOR),
        ...size,
      };
}

/**
 * Keeps a panel glued to its anchor for as long as it is open. Placement is
 * computed before the first paint — the panel never appears somewhere else
 * first — and again on any scroll or resize that could have moved the anchor.
 *
 * `revision` re-places the panel when the caller's own content changed size:
 * the property picker moving between its stages, an autocomplete's list growing.
 */
export function useAnchoredPosition(
  anchor: HTMLElement | null,
  options: AnchoredOptions = {},
  revision?: unknown,
): CSSProperties {
  const { width, minWidth, maxWidth, matchAnchorWidth, maxHeight, gap } = options;
  const place = useCallback(
    () =>
      placeAnchored(anchor?.getBoundingClientRect() ?? null, {
        width,
        minWidth,
        maxWidth,
        matchAnchorWidth,
        maxHeight,
        gap,
      }),
    [anchor, width, minWidth, maxWidth, matchAnchorWidth, maxHeight, gap],
  );
  const [style, setStyle] = useState(place);

  useLayoutEffect(() => {
    const reposition = () => setStyle(place());
    reposition();
    // Capture, because the anchor moves with whichever ancestor scrolls.
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [place, revision]);

  return style;
}
