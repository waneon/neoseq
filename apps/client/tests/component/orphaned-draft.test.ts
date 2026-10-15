// A draft whose block another replica removed is kept in a new block.

import { afterEach, expect, it, vi } from "vitest";
import { envelope } from "../../src/core-port/commands";
import type { GraphSession } from "../../src/core-port/session";
import { findPage } from "../../src/core-port/snapshot";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import { openWasmSession } from "./wasm-test-port";

const owner = { kind: "page", id: "home" } as const;
const sessions: GraphSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function draftInSecondBlock() {
  const { session, port } = await openWasmSession();
  sessions.push(session);
  await session.execute({ type: "ensure_page", page_id: owner.id, title: "Home" });
  for (const [index, markdown] of ["first", "second", "third"].entries()) {
    await session.execute({ type: "insert_block", owner, parent: null, index, markdown });
  }
  await session.hydrateOutline(owner);
  const block = findPage(session.getState().snapshot, owner.id)!.blocks[1];
  contentSessionsFor(session).open(owner, block.id, block.content).edit("second typed", []);
  return { session, port, blockId: block.id };
}

const texts = (session: GraphSession) =>
  findPage(session.getState().snapshot, owner.id)!.blocks.map((block) => block.markdown);

it("writes the draft where a peer deleted its block", async () => {
  const { session, port, blockId } = await draftInSecondBlock();
  const recovered: string[] = [];
  contentSessionsFor(session).onRecovered((_, id) => recovered.push(id));
  const peer = WasmGraphCore.fromSnapshot("test-graph", 999n, port.exportSnapshot());
  peer.executeJson(
    JSON.stringify(envelope("test-graph", { type: "delete_blocks", owner, block_ids: [blockId] })),
    "2026-10-15T00:00:00Z",
  );
  const inbound = session as unknown as { applyRemote(bytes: ArrayBuffer): Promise<void> };
  await inbound.applyRemote(peer.exportSnapshot().buffer as ArrayBuffer);
  await vi.waitFor(() => expect(recovered).toHaveLength(1));
  expect(texts(session)).toEqual(["first", "second typed", "third"]);
  peer.free();
});

it("lets this replica's own delete remove a block with a draft", async () => {
  const { session, blockId } = await draftInSecondBlock();
  await session.execute({ type: "delete_blocks", owner, block_ids: [blockId] });
  await session.executePrepared(() => null);
  expect(texts(session)).toEqual(["first", "third"]);
});
