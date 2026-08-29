import { describe, expect, it } from "vitest";
import {
  overlayReducer,
  pointerGestureReducer,
  type OutlineOverlay,
  type PointerGesture,
} from "../../src/features/outline/interaction-state";

describe("outline interaction state", () => {
  it("keeps exactly one overlay open", () => {
    const none: OutlineOverlay = { kind: "none" };
    const anchor = document.createElement("textarea");
    const slash = overlayReducer(none, {
      type: "open",
      overlay: {
        kind: "slash",
        request: {
          blockId: "pending-1",
          query: "q",
          start: 0,
          end: 2,
          anchorOffset: 0,
          anchor,
        },
        active: 0,
      },
    });
    const property = overlayReducer(slash, {
      type: "open",
      overlay: {
        kind: "property",
        request: { blockId: "block-1", anchor: null },
      },
    });

    expect(property).toEqual({
      kind: "property",
      request: { blockId: "block-1", anchor: null },
    });
    expect(overlayReducer(property, { type: "close", kind: "slash" })).toBe(property);
  });

  it("updates completion without disturbing another overlay", () => {
    const anchor = document.createElement("textarea");
    const property: OutlineOverlay = {
      kind: "property",
      request: { blockId: "block-1", anchor: null },
    };
    expect(overlayReducer(property, { type: "set-completion", overlay: null })).toBe(property);

    const slash = overlayReducer(property, {
      type: "set-completion",
      overlay: {
        kind: "slash",
        request: {
          blockId: "block-1",
          query: "q",
          start: 0,
          end: 2,
          anchorOffset: 0,
          anchor,
        },
        active: 0,
      },
    });
    expect(slash.kind).toBe("slash");
    expect(overlayReducer(slash, { type: "set-completion", overlay: null })).toEqual({
      kind: "none",
    });
  });

  it("moves a completion overlay from a pending id to its canonical block id", () => {
    const anchor = document.createElement("textarea");
    const pending: OutlineOverlay = {
      kind: "hash",
      request: {
        blockId: "pending-1",
        query: "tag",
        start: 0,
        end: 4,
        anchorOffset: 0,
        anchor,
      },
      active: 2,
    };

    expect(
      overlayReducer(pending, {
        type: "replace-pending-block",
        pendingId: "pending-1",
        blockId: "block-1",
      }),
    ).toEqual({
      kind: "hash",
      request: {
        blockId: "block-1",
        query: "tag",
        start: 0,
        end: 4,
        anchorOffset: 0,
        anchor,
      },
      active: 2,
    });
  });

  it("admits only one pointer gesture phase", () => {
    const idle: PointerGesture = { kind: "idle" };
    const selecting = pointerGestureReducer(idle, { type: "select" });
    const dragging = pointerGestureReducer(selecting, { type: "drag" });
    const target = { parentId: null, afterId: "block-1", depth: 0, gap: 1, top: 24 };

    expect(pointerGestureReducer(dragging, { type: "drop", target })).toEqual({
      kind: "dragging",
      drop: target,
    });
    expect(pointerGestureReducer(dragging, { type: "end" })).toEqual({ kind: "idle" });
  });
});
