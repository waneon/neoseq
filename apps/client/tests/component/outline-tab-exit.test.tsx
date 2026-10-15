// Tab indents; Escape, then Tab, leaves the outline as Tab does elsewhere.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("lets the Tab after Escape move focus instead of indenting", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    for (const [index, markdown] of ["first", "second"].entries()) {
      await harness.session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: null,
        index,
        markdown,
      });
    }
  });
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
  const second = screen.getAllByLabelText("Block text")[1];
  second.focus();

  fireEvent.keyDown(second, { key: "Escape" });
  expect(fireEvent.keyDown(second, { key: "Tab" })).toBe(true);
  // Only the one Tab: the next indents again.
  expect(fireEvent.keyDown(second, { key: "Tab" })).toBe(false);
});
