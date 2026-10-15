// Delete at the end of a block joins the block below.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

it("joins the next block into this one", async () => {
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
  const first = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(first);
  first.setSelectionRange(5, 5);
  await user.keyboard("{Delete}");
  await waitFor(() =>
    expect(
      findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
    ).toEqual(["firstsecond"]),
  );
  expect(screen.getByLabelText("Block text")).toHaveFocus();
});
