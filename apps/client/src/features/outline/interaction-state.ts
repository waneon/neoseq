import {
  blockCompletionReducer,
  type BlockCompletion,
  type BlockCompletionState,
} from "../blocks/editor/BlockCompletions";
import type { Anchor } from "@/ui/anchored";
import type { DropTarget } from "./selection";

export interface PropertyRequest {
  blockId: string;
  key?: string;
  anchor: Anchor;
  selection?: { start: number; end: number };
}

export interface TagRequest {
  blockId: string;
  anchor: HTMLElement | null;
}

export type OutlineOverlay =
  | BlockCompletionState
  | { kind: "property"; request: PropertyRequest }
  | { kind: "tag"; request: TagRequest }
  | { kind: "menu"; blockId: string };

export type OverlayAction =
  | { type: "open"; overlay: Exclude<OutlineOverlay, { kind: "none" }> }
  | { type: "close"; kind?: OutlineOverlay["kind"] }
  | { type: "set-completion"; overlay: BlockCompletion | null }
  | { type: "activate"; kind: "slash" | "hash"; index: number }
  | { type: "replace-pending-block"; pendingId: string; blockId: string };

export function overlayReducer(state: OutlineOverlay, action: OverlayAction): OutlineOverlay {
  switch (action.type) {
    case "open":
      return action.overlay;
    case "close":
      return action.kind === undefined || state.kind === action.kind ? { kind: "none" } : state;
    case "set-completion":
      if (action.overlay) return action.overlay;
      return state.kind === "slash" || state.kind === "hash"
        ? blockCompletionReducer(state, { type: "set", completion: null })
        : state;
    case "activate":
      return state.kind === "slash" || state.kind === "hash"
        ? blockCompletionReducer(state, action)
        : state;
    case "replace-pending-block":
      if (
        (state.kind !== "slash" && state.kind !== "hash")
        || state.request.blockId !== action.pendingId
      ) {
        return state;
      }
      return blockCompletionReducer(state, {
        type: "replace-block",
        from: action.pendingId,
        to: action.blockId,
      });
  }
}

export type VisibleDropTarget = DropTarget & { top: number };
export type PointerGesture =
  | { kind: "idle" }
  | { kind: "selecting" }
  | { kind: "dragging"; drop: VisibleDropTarget | null };

export type PointerGestureAction =
  | { type: "select" }
  | { type: "drag" }
  | { type: "drop"; target: VisibleDropTarget | null }
  | { type: "end" };

export function pointerGestureReducer(
  state: PointerGesture,
  action: PointerGestureAction,
): PointerGesture {
  switch (action.type) {
    case "select":
      return { kind: "selecting" };
    case "drag":
      return { kind: "dragging", drop: null };
    case "drop":
      return state.kind === "dragging" ? { ...state, drop: action.target } : state;
    case "end":
      return { kind: "idle" };
  }
}
