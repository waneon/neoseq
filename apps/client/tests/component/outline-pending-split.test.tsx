// Enter pressed again before a split's new block exists keeps every character.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function splitTwice(keys: string, expected: string[], reference = false) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "alpha beta gamma",
    });
    if (reference) {
      const block = findPage(harness.session.getState().snapshot, "home")!.blocks[0];
      await harness.session.execute({
        type: "splice_block_content",
        owner: { kind: "page", id: "home" },
        block_id: block.id,
        index: 11,
        delete: 0,
        insert: [{ type: "page_reference", page_id: "home" }],
      });
    }
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  // No delay between keys: the second Enter arrives before the first split's block exists.
  const user = userEvent.setup({ delay: null });
  await user.click(source);
  source.setSelectionRange(5, 5);
  await user.keyboard(keys);
  await waitFor(() =>
    expect(
      findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
    ).toEqual(expected),
  );
  return findPage(harness.session.getState().snapshot, "home")!.blocks;
}

describe("a split of a block still being created", () => {
  it("keeps the tail when Enter is pressed again at its start", async () => {
    await splitTwice("{Enter}{Enter}", ["alpha", "", " beta gamma"]);
  });

  it("keeps the tail when Enter is pressed again after typing", async () => {
    await splitTwice("{Enter}X{Enter}Y", ["alpha", "X", "Y beta gamma"]);
  });

  it("keeps a reference the tail carries", async () => {
    const blocks = await splitTwice("{Enter}X{Enter}", ["alpha", "X", " beta [[Home]]gamma"], true);
    expect(blocks[2].page_references).toHaveLength(1);
  });
});
