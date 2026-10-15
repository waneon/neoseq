// Keys pressed on a line still being created wait for it instead of vanishing.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

async function holdCreation(keys: string) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "one",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  source.setSelectionRange(3, 3);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let created: Promise<unknown> = Promise.resolve();
  const executePrepared = harness.session.executePrepared.bind(harness.session);
  harness.session.executePrepared = ((...args: Parameters<typeof executePrepared>) => {
    created = held.then(() => executePrepared(...args));
    return created;
  }) as typeof executePrepared;
  await user.keyboard(`{Enter}${keys}`);
  release();
  // The line exists before the deferred keys replay.
  await created;
  return () => findPage(harness.session.getState().snapshot, "home")?.blocks.map((b) => b.markdown);
}

it("moves a new line once it exists", async () => {
  const blocks = await holdCreation("two{Alt>}{ArrowUp}{/Alt}");
  await waitFor(() => expect(blocks()).toEqual(["two", "one"]));
});

it("undoes a new line once it exists", async () => {
  const blocks = await holdCreation("{Control>}z{/Control}");
  await waitFor(() => expect(blocks()).toEqual(["one"]));
});
