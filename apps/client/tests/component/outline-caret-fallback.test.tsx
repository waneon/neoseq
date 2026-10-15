// Undoing a paste keeps the caret in the outline.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("returns the caret to the block above when undo removes the focused block", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "anchor",
    });
  });
  const source = (await screen.findByLabelText("Block text")) as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  fireEvent.paste(source, {
    clipboardData: { getData: (type: string) => (type === "text/plain" ? "- one\n- two" : "") },
  });
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(3));
  await user.click(screen.getAllByLabelText("Block text")[2]);
  await harness.settle(() => user.keyboard("{Control>}z{/Control}"));
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(1));
  await waitFor(() => expect(screen.getByLabelText("Block text")).toHaveFocus());
});
