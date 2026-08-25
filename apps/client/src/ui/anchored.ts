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

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * What a panel can hang off: a thing with a box, or a box.
 *
 * The second form is for a panel whose anchor is *going* to be replaced before
 * the panel is even mounted. A query result's cell is the case: pressing it
 * hydrates the block it names, hydrating rebuilds the result, and the element
 * the press happened on is gone by the time the panel measures anything. The
 * press had a place on screen, though, and it is the place the reader is looking
 * at — so the caller captures it and hands that over instead of an element that
 * will not survive the trip.
 */
export type Anchor = HTMLElement | DOMRect | null;

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
 * A contextual panel disappears when the surface behind it moves.
 *
 * The anchor and surface remain scrollable. `exemptSelector` names a nested,
 * portaled surface that is still inside the interaction even though it is not a
 * DOM descendant — an autocomplete or select opened by a property picker.
 */
export interface AnchoredScrollDismissal {
  surface: RefObject<HTMLElement | null>;
  onExternalScroll: () => void;
  exemptSelector?: string;
}

/**
 * The fixed-position style for a panel hanging off `anchor`.
 *
 * A box with no area is not a position — it is the absence of one, and it is
 * normalised to `null` here. An element that has left the layout, detached by a
 * re-render or hidden inside a `display: none` subtree, still answers
 * `getBoundingClientRect()`, and it answers with zeroes; taken at face value that
 * is a real anchor sitting in the window's top-left corner, and a 360×420
 * property picker duly opened there. It happened in a query result and nowhere
 * else, because a query result is the one surface that replaces its own cells
 * underneath an open panel: hydrate a block, or write a value and let the query
 * re-run, and the cell the panel was hung on is a different element by the time
 * the panel measures it.
 *
 * With nothing to hang off, the panel opens near the top of the window rather
 * than at the origin.
 */
export function placeAnchored(anchor: DOMRect | null, options: AnchoredOptions = {}): CSSProperties {
  const rect = hasArea(anchor) ? anchor : null;
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

function hasArea(rect: DOMRect | null): rect is DOMRect {
  return rect !== null && (rect.width > 0 || rect.height > 0);
}

/** The anchor's box, or null when there is nothing there to measure. */
export function snapshotAnchor(anchor: Anchor): DOMRect | null {
  if (anchor === null) return null;
  if (!(anchor instanceof HTMLElement)) return hasArea(anchor) ? anchor : null;
  if (!anchor.isConnected) return null;
  const rect = anchor.getBoundingClientRect();
  return hasArea(rect) ? rect : null;
}

/**
 * Keeps a panel glued to its anchor for as long as it is open. Placement is
 * computed before the first paint — the panel never appears somewhere else
 * first — and again on any resize that could have moved the anchor. By default
 * it also follows scrolling; a contextual caller may instead provide
 * `scrollDismissal`, making external scroll close the panel while its own list
 * remains scrollable.
 *
 * When the anchor stops being measurable while the panel is up, the panel *stays
 * where it is*. The alternative is to re-place it from nothing, and there is no
 * better guess available than the position it already holds — which is also the
 * one the reader is currently looking at. Only a panel that never had an anchor
 * falls back to the centred placement.
 *
 * `revision` re-places the panel when the caller's own content changed size:
 * the property picker moving between its stages, an autocomplete's list growing.
 */
export function useAnchoredPosition(
  anchor: Anchor,
  options: AnchoredOptions = {},
  revision?: unknown,
  scrollDismissal?: AnchoredScrollDismissal,
): CSSProperties {
  const { width, minWidth, maxWidth, matchAnchorWidth, maxHeight, gap } = options;
  const dismissRef = useRef(scrollDismissal?.onExternalScroll);
  dismissRef.current = scrollDismissal?.onExternalScroll;
  const dismissSurface = scrollDismissal?.surface;
  const dismissExemptSelector = scrollDismissal?.exemptSelector;
  // The last box this anchor actually had. An anchor that stops being measurable
  // while its panel is open — a cell replaced by its own query's next result — is
  // best answered with where it was: that is where the reader pressed, and there
  // is no better guess than the position they are already looking at.
  const known = useRef<DOMRect | null>(null);
  const place = useCallback(() => {
    const rect = snapshotAnchor(anchor) ?? known.current;
    known.current = rect;
    return placeAnchored(rect, {
      width,
      minWidth,
      maxWidth,
      matchAnchorWidth,
      maxHeight,
      gap,
    });
  }, [anchor, width, minWidth, maxWidth, matchAnchorWidth, maxHeight, gap]);
  const [style, setStyle] = useState(place);

  useLayoutEffect(() => {
    const reposition = () => setStyle(place());
    const handleScroll = (event: Event) => {
      if (!dismissRef.current) {
        reposition();
        return;
      }

      const target = event.target;
      if (target instanceof Node && dismissSurface?.current?.contains(target)) return;
      if (target instanceof Node && anchor instanceof HTMLElement && anchor.contains(target)) return;
      if (
        target instanceof Element
        && dismissExemptSelector
        && target.closest(dismissExemptSelector)
      ) return;
      dismissRef.current();
    };
    reposition();
    // Capture, because the anchor moves with whichever ancestor scrolls.
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [dismissExemptSelector, dismissSurface, place, revision]);

  return style;
}
