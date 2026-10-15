// Cutting text with a page reference and pasting it back keeps the reference.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

it("moves a reference within a block through cut and paste", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({ type: "ensure_page", page_id: "target", title: "Target" });
    const inserted = await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "see  now",
    });
    await harness.session.execute({
      type: "splice_block_content",
      owner: { kind: "page", id: "home" },
      block_id: inserted.created_block!,
      index: 4,
      delete: 0,
      insert: [{ type: "page_reference", page_id: "target" }],
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  await userEvent.setup().click(source);
  expect(source).toHaveValue("see [[Target]] now");

  const values = new Map<string, string>();
  source.setSelectionRange(4, 14);
  fireEvent.cut(source, {
    clipboardData: { setData: (type: string, value: string) => values.set(type, value) },
  });
  expect(source).toHaveValue("see  now");
  expect(values.get("text/plain")).toBe("[[Target]]");

  source.setSelectionRange(8, 8);
  fireEvent.paste(source, {
    clipboardData: { getData: (type: string) => values.get(type) ?? "" },
  });
  expect(source).toHaveValue("see  now[[Target]]");
  expect(source.selectionStart).toBe(18);
  await waitFor(() => {
    const block = findPage(harness.session.getState().snapshot, "home")!.blocks[0];
    expect(block.markdown).toBe("see  now[[Target]]");
    expect(block.page_references).toHaveLength(1);
  });
});
