import { describe, expect, it } from "vitest";
import {
  initialOutlineDraftState,
  outlineDraftReducer,
} from "../../src/features/outline/draft-state";

describe("outline draft state", () => {
  it("adopts a pending row and remaps the next queued anchor atomically", () => {
    const first = {
      kind: "insert" as const,
      tempId: "pending-1",
      anchorId: "block-1",
      mode: "sibling" as const,
      created: { markdown: "tail", pageReferences: [] },
      dispatched: true,
      structural: ["indent" as const],
    };
    const second = {
      kind: "insert" as const,
      tempId: "pending-2",
      anchorId: "pending-1",
      mode: "sibling" as const,
      created: { markdown: "next", pageReferences: [] },
      dispatched: false,
      structural: [],
    };
    let state = outlineDraftReducer(initialOutlineDraftState, {
      type: "enqueue",
      operation: first,
    });
    state = outlineDraftReducer(state, { type: "enqueue", operation: second });
    state = outlineDraftReducer(state, {
      type: "edit",
      id: "pending-1",
      value: "tail typed",
    });
    state = outlineDraftReducer(state, {
      type: "adopt",
      tempId: "pending-1",
      blockId: "block-2",
      typed: "tail typed",
    });

    expect(state.pendingOperations).toEqual([{ ...second, anchorId: "block-2" }]);
    expect(state.drafts.get("block-2")).toBe("tail typed");
    expect(state.baselines.get("block-2")).toBe("tail");
    expect(state.drafts.has("pending-1")).toBe(false);
  });

  it("keeps baseline creation and generated closer provenance in one edit", () => {
    const marker = { offset: 4, opener: "[", closer: "]" };
    const state = outlineDraftReducer(initialOutlineDraftState, {
      type: "edit",
      id: "block-1",
      value: "[text]",
      baselineIfAbsent: "text",
      autoClosers: [marker],
    });

    expect(state.drafts.get("block-1")).toBe("[text]");
    expect(state.baselines.get("block-1")).toBe("text");
    expect(state.autoClosers.get("block-1")).toEqual([marker]);
  });

  it("abandons only optimistic rows and their drafts", () => {
    let state = outlineDraftReducer(initialOutlineDraftState, {
      type: "edit",
      id: "block-1",
      value: "kept",
      baselineIfAbsent: "",
    });
    state = outlineDraftReducer(state, {
      type: "enqueue",
      operation: {
        kind: "insert",
        tempId: "pending-1",
        anchorId: "block-1",
        mode: "sibling",
        created: { markdown: "lost", pageReferences: [] },
        dispatched: false,
        structural: [],
      },
    });
    state = outlineDraftReducer(state, { type: "abandon-pending" });

    expect(state.pendingOperations).toEqual([]);
    expect(state.drafts.get("block-1")).toBe("kept");
    expect(state.drafts.has("pending-1")).toBe(false);
  });

  it("does not let an out-of-order acknowledgement consume the queue head", () => {
    const state = outlineDraftReducer(initialOutlineDraftState, {
      type: "enqueue",
      operation: {
        kind: "insert",
        tempId: "pending-1",
        anchorId: "block-1",
        mode: "sibling",
        created: { markdown: "typed", pageReferences: [] },
        dispatched: true,
        structural: [],
      },
    });

    const unchanged = outlineDraftReducer(state, {
      type: "adopt",
      tempId: "pending-2",
      blockId: "block-2",
      typed: "wrong row",
    });

    expect(unchanged).toBe(state);
  });
});
