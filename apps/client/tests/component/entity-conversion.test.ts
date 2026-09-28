import { expect, it } from "vitest";
import { openWasmSession } from "./wasm-test-port";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { projectBuffer } from "../../src/features/blocks/editor/content-buffer";
import { findTag, outlineOwnerKey } from "../../src/core-port/snapshot";
import { WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import { envelope } from "../../src/core-port/commands";

it("a remote kind change preserves a composing draft and the hydrated outline identity", async () => {
  const { session, port } = await openWasmSession();
  let peer: WasmGraphCore | undefined;
  try {
    const owner = { kind: "page", id: "env" } as const;
    await session.execute({ type: "ensure_page", page_id: owner.id, title: "env" });
    const created = await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 0,
      markdown: "abcdef",
    });
    await session.hydrateOutline(owner);
    const block = session.getState().snapshot.pages[0].blocks[0];
    expect(created.created_block).toBe(block.id);
    const draft = contentSessionsFor(session).open(owner, block.id, block.content);
    draft.setComposing(true);
    draft.edit("abc한def", []);
    peer = WasmGraphCore.fromSnapshot("test-graph", 999n, port.exportSnapshot());
    peer.executeJson(
      JSON.stringify(
        envelope("test-graph", { type: "set_entity_kind", id: owner.id, kind: "tag" }),
      ),
      "2026-09-28T00:00:00Z",
    );
    peer.takeUpdate();
    peer.executeJson(
      JSON.stringify(
        envelope("test-graph", {
          type: "splice_block_content",
          owner: { kind: "tag", id: owner.id },
          block_id: block.id,
          index: 1,
          delete: 0,
          insert: [{ type: "markdown", value: "X" }],
        }),
      ),
      "2026-09-28T00:00:01Z",
    );
    await (session as unknown as { applyRemote(bytes: ArrayBuffer): Promise<void> }).applyRemote(
      peer.exportSnapshot().buffer as ArrayBuffer,
    );
    expect(session.getState().snapshot.pages).toHaveLength(0);
    expect(findTag(session.getState().snapshot, owner.id)?.blocks[0].id).toBe(block.id);
    expect(
      session.getState().hydratedOutlines.has(outlineOwnerKey({ kind: "tag", id: owner.id })),
    ).toBe(true);
    expect(projectBuffer(draft.buffer, []).markdown).toBe("abc한def");
    draft.setComposing(false);
    expect(projectBuffer(draft.buffer, []).markdown).toBe("aXbc한def");
    await draft.submit();
    expect(findTag(session.getState().snapshot, owner.id)?.blocks[0].markdown).toBe("aXbc한def");
  } finally {
    peer?.free();
    await session.close();
  }
});
