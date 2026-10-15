// Cutting a block selection copies it and removes it, as one gesture.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("cuts the selected blocks to the clipboard", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  for (const [index, markdown] of ["keep", "cut me"].entries()) {
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index,
      markdown,
    });
  }
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
  fireEvent.pointerDown(screen.getAllByTestId("row-grip")[1], {
    button: 0,
    clientX: 2,
    clientY: 10,
  });
  fireEvent.pointerUp(window, { button: 0, clientX: 2, clientY: 10 });
  expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("data-selected", "true");

  const values = new Map<string, string>();
  fireEvent.cut(screen.getByRole("tree"), {
    clipboardData: { setData: (type: string, value: string) => values.set(type, value) },
  });
  expect(values.get("text/plain")).toContain("cut me");
  await waitFor(() =>
    expect(
      harness.session
        .getState()
        .snapshot.pages.find((page) => page.id === "home")
        ?.blocks.map((block) => block.markdown),
    ).toEqual(["keep"]),
  );
});
