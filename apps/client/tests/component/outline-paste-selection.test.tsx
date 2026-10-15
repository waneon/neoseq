// Pasted blocks take the place of the text selected when they arrive.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function pasteOver(start: number, end: number) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "keep replace",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  await userEvent.setup().click(source);
  source.setSelectionRange(start, end);
  fireEvent.paste(source, {
    clipboardData: { getData: (type: string) => (type === "text/plain" ? "- one\n- two" : "") },
  });
  return () =>
    findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown);
}

it("replaces selected words with the pasted list", async () => {
  const texts = await pasteOver(4, 12);
  await waitFor(() => expect(texts()).toEqual(["keep", "one", "two"]));
});

it("replaces a wholly selected block with the pasted list", async () => {
  const texts = await pasteOver(0, 12);
  await waitFor(() => expect(texts()).toEqual(["one", "two"]));
});
