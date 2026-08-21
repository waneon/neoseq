// Where a summoned panel opens, measured rather than eyeballed.
//
// Every one of these was a real defect on screen: a property picker in the corner
// of the window, a tag picker opening off the right edge of the measure and
// sliding back, a combobox list right-aligned under its own field.

import { beforeAll, describe, expect, it } from "vitest";
import { placeAnchored } from "../../src/ui/anchored";

const VIEWPORT = { width: 1280, height: 720 };
const PANEL = { width: 360, minWidth: 280, maxHeight: 420 } as const;

beforeAll(() => {
  window.innerWidth = VIEWPORT.width;
  window.innerHeight = VIEWPORT.height;
});

describe("placeAnchored", () => {
  it("hangs a panel under an anchor on the left half by its left edge", () => {
    const style = placeAnchored(new DOMRect(120, 200, 80, 24), PANEL);
    expect(style.left).toBe(120);
    expect(style.right).toBeUndefined();
    expect(style.top).toBe(228);
  });

  it("opens a mark near the right edge leftwards, pinned by its right edge", () => {
    // A tag at the end of a line of writing. Pinned by `right` rather than offset
    // by the panel's guessed width, so a content-sized panel still meets the edge
    // it is meant to meet.
    const style = placeAnchored(new DOMRect(1000, 200, 60, 24), PANEL);
    expect(style.left).toBeUndefined();
    expect(style.right).toBe(VIEWPORT.width - 1060);
  });

  it("keeps a field's left edge however far right the field sits", () => {
    // The panel is standing in for the field, so it inherits its left edge: a
    // slash menu that jumped to the far end of the line the caret is at the start
    // of would be worse than anything the rule above fixes.
    const wide = placeAnchored(new DOMRect(700, 200, 520, 26), PANEL);
    expect(wide.left).toBe(700);
    const combobox = placeAnchored(new DOMRect(900, 200, 200, 32), {
      matchAnchorWidth: true,
      maxWidth: 320,
    });
    expect(combobox.left).toBe(900);
  });

  it("flips above the anchor when the room below cannot hold the panel", () => {
    const style = placeAnchored(new DOMRect(120, 600, 80, 24), PANEL);
    expect(style.top).toBeUndefined();
    expect(style.bottom).toBe(VIEWPORT.height - 600 + 4);
  });

  it("takes a frozen box as an anchor in its own right", () => {
    // What a query result hands over: the box the press happened in, because the
    // element it happened on will not survive the hydrate the press starts.
    const style = placeAnchored(new DOMRect(722, 401, 180, 28), PANEL);
    expect(style.top).toBe(433);
    // A 180px cell in the right half of the window is a mark, so it opens
    // leftwards — the rule above, reached through a box rather than an element.
    expect(style.right).toBe(VIEWPORT.width - 902);
  });

  it("treats a box with no area as no anchor at all", () => {
    // An element that has left the layout still answers `getBoundingClientRect`,
    // and it answers with zeroes. Read as a position that is the window's
    // top-left corner, which is where a 360×420 property picker used to jump the
    // moment a query result replaced the cell it was hung on.
    const detached = placeAnchored(new DOMRect(0, 0, 0, 0), PANEL);
    const nothing = placeAnchored(null, PANEL);
    expect(detached).toEqual(nothing);
    expect(detached.left).toBe((VIEWPORT.width - 360) / 2);
  });
});
