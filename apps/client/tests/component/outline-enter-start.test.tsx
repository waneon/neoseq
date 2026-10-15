// Enter at the start of a block opens a line above and leaves the caret with the text.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

it("keeps the caret at the start of the text that moved down", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "text",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  source.setSelectionRange(0, 0);
  await user.keyboard("{Enter}more ");
  await waitFor(() =>
    expect(
      findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
    ).toEqual(["", "more text"]),
  );
});

it("shows text typed before the new line is acknowledged", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "text",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  source.setSelectionRange(0, 0);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const executePrepared = harness.session.executePrepared.bind(harness.session);
  harness.session.executePrepared = (async (...args: Parameters<typeof executePrepared>) => {
    await held;
    return executePrepared(...args);
  }) as typeof executePrepared;

  await user.keyboard("{Enter}more ");
  expect(source).toHaveValue("more text");
  expect(source.selectionStart).toBe(5);
  release();
  await waitFor(() =>
    expect(
      findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
    ).toEqual(["", "more text"]),
  );
});
