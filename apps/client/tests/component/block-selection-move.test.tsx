// A selected run of blocks moves with Alt+Arrow and stays selected.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { findPage } from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";

function pressBullet(index: number, init: MouseEventInit = {}) {
  const bullet = screen.getAllByTestId("block-bullet")[index];
  fireEvent.pointerDown(bullet, { button: 0, clientX: 10, clientY: 10, ...init });
  fireEvent.pointerUp(window, { button: 0, clientX: 10, clientY: 10 });
}

it("moves selected siblings up as one", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  for (const [index, markdown] of ["a", "b", "c", "d"].entries()) {
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index,
      markdown,
    });
  }
  await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(4));
  pressBullet(1);
  pressBullet(2, { shiftKey: true });
  fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowUp", altKey: true });
  await waitFor(() =>
    expect(
      findPage(harness.session.getState().snapshot, "home")?.blocks.map((block) => block.markdown),
    ).toEqual(["b", "c", "a", "d"]),
  );
  const selected = screen
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => row.querySelector("textarea")?.value);
  expect(selected).toEqual(["b", "c"]);
});
