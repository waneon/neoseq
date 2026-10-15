// Input an editor still holds when the page goes away is kept and replayed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { findBlock, findOutline, type OutlineOwner } from "../../src/core-port/snapshot";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { MemoryGraphStore, openWasmSession } from "./wasm-test-port";

const owner: OutlineOwner = { kind: "page", id: "home" };

async function openWithBlock(store: MemoryGraphStore) {
  const { session } = await openWasmSession("unsaved-graph", store);
  await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  const result = await session.execute({
    type: "insert_block",
    owner,
    parent: null,
    index: 0,
    markdown: "alpha",
  });
  await session.hydrateOutline(owner);
  return { session, id: result.created_block! };
}

function hide() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.restoreAllMocks();
}

async function reopen(store: MemoryGraphStore, id: string) {
  const { session } = await openWasmSession("unsaved-graph", store);
  await session.hydrateOutline(owner);
  await session.executePrepared(() => null);
  const text = findBlock(findOutline(session.getState().snapshot, owner)!, id)?.markdown;
  await session.close();
  return text;
}

describe("input kept when the page goes away", () => {
  afterEach(() => localStorage.clear());

  it("replays a block draft the graph never received", async () => {
    const store = new MemoryGraphStore();
    const { session, id } = await openWithBlock(store);
    const target = contentSessionsFor(session).target(owner, id);
    target.splice(5, 0, [{ type: "markdown", value: " beta" }]);
    hide();
    await session.close();
    expect(await reopen(store, id)).toBe("alpha beta");
    expect(await reopen(store, id)).toBe("alpha beta");
  });

  it("leaves a block that changed from what the draft knew", async () => {
    const store = new MemoryGraphStore();
    const { session, id } = await openWithBlock(store);
    const target = contentSessionsFor(session).target(owner, id);
    target.splice(5, 0, [{ type: "markdown", value: " beta" }]);
    hide();
    await session.execute({ type: "edit_markdown", owner, block_id: id, markdown: "changed" });
    await session.close();
    expect(await reopen(store, id)).toBe("changed");
  });
});
