// A new block lands beside its anchor even when a queued remote insert moved it.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { envelope } from "../../src/core-port/commands";
import { findPage } from "../../src/core-port/snapshot";
import { WasmGraphCore } from "../../src/wasm/neoseq_core.js";
import { GRAPH_ID, mountAt } from "./harness";

const owner = { kind: "page", id: "home" } as const;

it("places a new block after its anchor as the queue left it", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session, port } = harness;
  await harness.settle(async () => {
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    for (const [index, markdown] of ["above", ""].entries()) {
      await session.execute({ type: "insert_block", owner, parent: null, index, markdown });
    }
  });
  const peer = WasmGraphCore.fromSnapshot(GRAPH_ID, 999n, port.exportSnapshot());
  peer.executeJson(
    JSON.stringify(
      envelope(GRAPH_ID, {
        type: "insert_block",
        owner,
        parent: null,
        index: 1,
        markdown: "peer",
      }),
    ),
    "2026-10-15T00:00:00Z",
  );

  const queue = session as unknown as {
    enqueue(work: () => Promise<void>): Promise<void>;
    applyRemote(bytes: ArrayBuffer): Promise<void>;
  };
  let release!: () => void;
  void queue.enqueue(() => new Promise<void>((resolve) => (release = resolve)));
  void queue.applyRemote(peer.exportSnapshot().buffer as ArrayBuffer);

  const empty = screen.getAllByLabelText("Block text")[1] as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(empty);
  await user.keyboard("{Enter}next");
  release();
  await waitFor(() =>
    expect(findPage(session.getState().snapshot, "home")?.blocks.map((b) => b.markdown)).toEqual([
      "above",
      "peer",
      "",
      "next",
    ]),
  );
  peer.free();
});
