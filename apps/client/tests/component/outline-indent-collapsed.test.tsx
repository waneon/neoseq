// Indenting under a collapsed block keeps the indented block and its caret in view.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("opens a collapsed block that Tab makes a parent", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const owner = { kind: "page", id: "home" } as const;
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    for (const [index, markdown] of ["parent", "child", "next"].entries()) {
      await harness.session.execute({
        type: "insert_block",
        owner,
        parent: null,
        index,
        markdown,
      });
    }
    const [, child] = harness.session.getState().snapshot.pages[0].blocks;
    await harness.session.execute({ type: "indent_blocks", owner, block_ids: [child.id] });
  });
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button", { name: "Collapse" })[0]);
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));

  await user.click(screen.getAllByLabelText("Block text")[1]);
  await user.keyboard("{Tab}");
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(3));
  const indented = screen.getAllByLabelText("Block text")[2];
  expect(indented).toHaveValue("next");
  await waitFor(() => expect(indented).toHaveFocus());
});
