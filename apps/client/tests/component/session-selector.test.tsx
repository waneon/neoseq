import { act, renderHook } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { GraphSession, SessionState } from "../../src/core-port/session";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import { SessionContext, useSessionSelector } from "../../src/features/shell/session-context";

describe("session selectors", () => {
  it("does not render an outline subscriber for a save-only publication", () => {
    let state: SessionState = {
      status: "ready",
      mode: "exclusive",
      snapshot: EMPTY_SNAPSHOT,
      save: { kind: "saved", sequence: 0 },
      capabilities: null,
      recovery: null,
      error: null,
      revision: 0,
      canonicalRevision: 0,
      hydratedOutlines: new Set(),
      sync: { kind: "local" },
      live: "local",
      presence: new Map(),
    };
    const listeners = new Set<() => void>();
    const session = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () => state,
    } as unknown as GraphSession;
    let renders = 0;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    );

    const { result } = renderHook(
      () => {
        renders += 1;
        return useSessionSelector((current) => current.snapshot);
      },
      { wrapper },
    );
    const initialRenders = renders;

    act(() => {
      state = { ...state, save: { kind: "saving" } };
      for (const listener of listeners) listener();
    });
    expect(renders).toBe(initialRenders);

    act(() => {
      state = { ...state, snapshot: { ...state.snapshot, graph_id: "changed" } };
      for (const listener of listeners) listener();
    });
    expect(renders).toBe(initialRenders + 1);
    expect(result.current.graph_id).toBe("changed");
  });
});
