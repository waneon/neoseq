// A tab without the lease shows what the holder saves and takes over when it leaves.

import { afterEach, expect, it, vi } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import type { GraphSession } from "../../src/core-port/session";
import { MemoryGraphStore, WasmTestPort } from "./wasm-test-port";

const owner = { kind: "page", id: "home" } as const;
const originalLocks = navigator.locks;
const sessions: GraphSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
});

/** A fresh module graph stands in for another tab with its own lease table. */
async function openInAnotherTab(store: MemoryGraphStore): Promise<GraphSession> {
  vi.resetModules();
  const { GraphSession } = await import("../../src/core-port/session");
  const session = new GraphSession("follow-graph", new WasmTestPort(store));
  sessions.push(session);
  await session.open();
  return session;
}

it("follows the holder's saves and takes the lease when the holder closes", async () => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const store = new MemoryGraphStore();
  const writer = await openInAnotherTab(store);
  await writer.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  const reader = await openInAnotherTab(store);
  expect(reader.getState().readonlyReason).toBe("lease");
  await reader.hydrateOutline(owner);

  await writer.execute({ type: "insert_block", owner, parent: null, index: 0, markdown: "saved" });
  await vi.waitFor(() =>
    expect(findPage(reader.getState().snapshot, "home")?.blocks[0]?.markdown).toBe("saved"),
  );

  await writer.close();
  await vi.waitFor(() => expect(reader.getState().mode).toBe("exclusive"), { timeout: 3_000 });
  await reader.execute({ type: "insert_block", owner, parent: null, index: 1, markdown: "mine" });
  expect(
    findPage(reader.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
  ).toEqual(["saved", "mine"]);
});
