// Undo and redo leave the caret where the text changed.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

async function mountWith(...lines: string[]) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    for (const [index, markdown] of lines.entries()) {
      await harness.session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: null,
        index,
        markdown,
      });
    }
  });
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(lines.length));
  return harness;
}

it("puts the caret where undo and redo change the focused block", async () => {
  const harness = await mountWith("one three");
  const source = screen.getByLabelText("Block text") as HTMLTextAreaElement;
  const user = userEvent.setup();
  await user.click(source);
  source.setSelectionRange(4, 4);
  await harness.settle(() => user.keyboard("two "));
  source.setSelectionRange(source.value.length, source.value.length);

  await harness.settle(() => user.keyboard("{Control>}z{/Control}"));
  await waitFor(() => expect(source).toHaveValue("one three"));
  await waitFor(() => expect(source.selectionStart).toBe(4));

  source.setSelectionRange(0, 0);
  await harness.settle(() => user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}"));
  await waitFor(() => expect(source).toHaveValue("one two three"));
  await waitFor(() => expect(source.selectionStart).toBe(8));
  expect(source.selectionEnd).toBe(8);
});

it("puts the caret at the change when undo moves to another block", async () => {
  const harness = await mountWith("one three", "other");
  const [first, second] = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];
  const user = userEvent.setup();
  await user.click(first);
  first.setSelectionRange(4, 4);
  await harness.settle(() => user.keyboard("two "));
  await harness.settle(() => user.click(second));

  await harness.settle(() => user.keyboard("{Control>}z{/Control}"));
  const source = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
  await waitFor(() => expect(source).toHaveValue("one three"));
  await waitFor(() => expect(source).toHaveFocus());
  expect(source.selectionStart).toBe(4);
});
