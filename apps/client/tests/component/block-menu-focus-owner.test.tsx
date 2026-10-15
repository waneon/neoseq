// A surface opened over a block menu returns focus to the block, not the menu.

import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { currentFocusOwner } from "../../src/ui/overlay-focus";
import { GRAPH_ID, mountAt, openBlockMenu } from "./harness";

it("names the block's text as the owner of focus inside its menu", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "hello",
    });
  });
  const menu = await openBlockMenu();
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  expect(currentFocusOwner()).toBe(screen.getByLabelText("Block text"));
});
