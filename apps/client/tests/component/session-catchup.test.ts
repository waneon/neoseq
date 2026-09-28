import { expect, it } from "vitest";
import { envelope } from "../../src/core-port/commands";
import { findPage } from "../../src/core-port/snapshot";
import { contentSessionsFor } from "../../src/features/blocks/editor/content-session";
import { projectBuffer } from "../../src/features/blocks/editor/content-buffer";
import { transformProjectedSelection } from "../../src/features/blocks/editor/selection";
import { WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import { openWasmSession } from "./wasm-test-port";
import { CorePortFailure } from "../../src/core-worker";
import type { GraphSession } from "../../src/core-port/session";

const owner = { kind: "page", id: "home" } as const;
// Drive the same serialized boundary used by the SyncAgent delegate.
function inbound(session: GraphSession) {
  return session as unknown as {
    applyRemote(bytes: ArrayBuffer, current?: () => boolean): Promise<void>;
    replaceRemote(bytes: number[], epoch: number, vector: number[]): Promise<void>;
  };
}

for (const composing of [false, true]) {
  it(`bulk catch-up preserves a ${composing ? "composing" : "typing"} draft, caret, and subsequent edits`, async () => {
    const { session, port } = await openWasmSession();
    let server: WasmGraphCore | undefined;
    try {
      await session.execute({ type: "ensure_page", page_id: owner.id, title: "Home" });
      await session.execute({
        type: "insert_block",
        owner,
        parent: null,
        index: 0,
        markdown: "abcdef",
      });
      await session.hydrateOutline(owner);
      const block = findPage(session.getState().snapshot, owner.id)!.blocks[0];
      const target = contentSessionsFor(session).open(owner, block.id, block.content);
      let selection = { anchor: 4, head: 4 };
      target.observe((change) => {
        selection = transformProjectedSelection(change, selection);
      });
      if (composing) target.setComposing(true);
      target.edit("abc한def", []);
      server = WasmGraphCore.fromSnapshot("test-graph", 999n, port.exportSnapshot());
      server.executeJson(
        JSON.stringify(
          envelope("test-graph", {
            type: "splice_block_content",
            owner,
            block_id: block.id,
            index: 1,
            delete: 0,
            insert: [{ type: "markdown", value: "X" }],
          }),
        ),
        "2026-09-28T00:00:00Z",
      );
      await inbound(session).applyRemote(server.exportSnapshot().buffer as ArrayBuffer);
      if (composing) {
        expect(projectBuffer(target.buffer, []).markdown).toBe("abc한def");
        expect(selection).toEqual({ anchor: 4, head: 4 });
        target.setComposing(false);
      }
      expect(projectBuffer(target.buffer, []).markdown).toBe("aXbc한def");
      expect(selection).toEqual({ anchor: 5, head: 5 });
      await target.submit();
      target.edit("aXbc한글def", []);
      await target.submit();
      expect(findPage(session.getState().snapshot, owner.id)!.blocks[0].markdown).toBe(
        "aXbc한글def",
      );
    } finally {
      server?.free();
      await session.close();
    }
  });
}

it("bulk import preserves local undo and ignores an obsolete queued import", async () => {
  const { session, port } = await openWasmSession();
  let server: WasmGraphCore | undefined;
  try {
    await session.execute({ type: "ensure_page", page_id: owner.id, title: "Home" });
    server = WasmGraphCore.fromSnapshot("test-graph", 999n, port.exportSnapshot());
    await session.execute({ type: "rename_page", page_id: owner.id, title: "Local" });
    server.executeJson(
      JSON.stringify(
        envelope("test-graph", {
          type: "ensure_page",
          page_id: "remote",
          title: "Remote",
        }),
      ),
      "2026-09-28T00:00:00Z",
    );
    await inbound(session).applyRemote(server.exportSnapshot().buffer as ArrayBuffer, () => false);
    expect(findPage(session.getState().snapshot, "remote")).toBeUndefined();
    await inbound(session).applyRemote(server.exportSnapshot().buffer as ArrayBuffer);
    await session.execute({ type: "undo" });
    expect(findPage(session.getState().snapshot, owner.id)!.title).toBe("Home");
    expect(findPage(session.getState().snapshot, "remote")!.title).toBe("Remote");
  } finally {
    server?.free();
    await session.close();
  }
});

it("keeps the session editable after an incompatible replacement is refused", async () => {
  const { session, port } = await openWasmSession();
  try {
    await session.execute({ type: "ensure_page", page_id: owner.id, title: "Home" });
    Object.assign(port, {
      replaceRemote: async () => {
        throw new CorePortFailure({
          code: "resync_required",
          message: "local data preserved",
          retryable: false,
        });
      },
    });
    await expect(inbound(session).replaceRemote([1], 2, [])).rejects.toMatchObject({
      detail: { code: "resync_required" },
    });
    await session.execute({ type: "rename_page", page_id: owner.id, title: "Still editable" });
    expect(findPage(session.getState().snapshot, owner.id)!.title).toBe("Still editable");
  } finally {
    await session.close();
  }
});
