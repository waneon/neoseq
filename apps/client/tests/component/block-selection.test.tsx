// Selecting several blocks and acting on them as one.
//
// The marquee itself needs real layout, so it belongs to the browser suite; what
// is tested here is everything that does not: the two pointer gestures a list has
// always had, the menu the selection puts on the bullet, and the bare keys the
// tree answers to once a selection exists.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

async function mountRows(markdowns: string[]) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  for (const [index, markdown] of markdowns.entries()) {
    await harness.session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index,
      markdown,
    });
  }
  await waitFor(() =>
    expect(screen.getAllByLabelText("Block text")).toHaveLength(markdowns.length),
  );
  return harness;
}

/** A press-and-release on a bullet, with no travel: a click, not a drag. */
function pressBullet(index: number, init: MouseEventInit = {}) {
  const bullet = screen.getAllByTestId("block-bullet")[index];
  fireEvent.pointerDown(bullet, { button: 0, clientX: 10, clientY: 10, ...init });
  fireEvent.pointerUp(window, { button: 0, clientX: 10, clientY: 10 });
}

function selectedTexts(): string[] {
  return screen
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("data-selected") === "true")
    .map((row) => row.querySelector("textarea")?.value ?? "");
}

describe("block selection", () => {
  it("extends from the last touched bullet with shift, and toggles one with the modifier", async () => {
    await mountRows(["one", "two", "three", "four"]);

    pressBullet(0);
    pressBullet(2, { shiftKey: true });
    expect(selectedTexts()).toEqual(["one", "two", "three"]);

    pressBullet(3, { metaKey: true });
    expect(selectedTexts()).toEqual(["one", "two", "three", "four"]);
    pressBullet(3, { metaKey: true });
    expect(selectedTexts()).toEqual(["one", "two", "three"]);
  });

  it("puts the caret back and drops the selection when a bullet is clicked plainly", async () => {
    await mountRows(["one", "two"]);
    pressBullet(0);
    pressBullet(1, { shiftKey: true });
    expect(selectedTexts()).toHaveLength(2);

    pressBullet(1);
    expect(selectedTexts()).toEqual([]);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByLabelText("Block text")[1]),
    );
  });

  it("deletes every selected block as one undoable command", async () => {
    const user = userEvent.setup();
    const { session, port } = await mountRows(["one", "two", "three"]);
    const commands: string[] = [];
    port.beforeExecute = async (command) => {
      commands.push(command.type);
    };
    pressBullet(0);
    pressBullet(1, { shiftKey: true });

    fireEvent.contextMenu(screen.getAllByTestId("block-bullet")[1]);
    const item = await screen.findByTestId("menu-delete-selection");
    expect(item).toHaveTextContent("Delete 2 blocks");
    await user.click(item);

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["three"]);
    });
    expect(commands).toEqual(["delete_blocks"]);

    await session.execute({ type: "undo" });
    expect(
      session.getState().snapshot.pages.find((entry) => entry.id === "home")?.blocks
        .map((block) => block.markdown),
    ).toEqual(["one", "two", "three"]);

    await session.execute({ type: "redo" });
    expect(
      session.getState().snapshot.pages.find((entry) => entry.id === "home")?.blocks
        .map((block) => block.markdown),
    ).toEqual(["three"]);
  });

  it("indents the whole selection under one new parent", async () => {
    const { session } = await mountRows(["parent", "one", "two"]);
    pressBullet(1);
    pressBullet(2, { shiftKey: true });

    // The tree holds focus while a selection exists, so ⇥ reaches it without
    // ever being taken from a text field.
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Tab" });

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["parent"]);
      expect(page?.blocks[0].children.map((block) => block.markdown)).toEqual(["one", "two"]);
    });
  });

  it("outdents the whole selection back out, in order", async () => {
    const { session } = await mountRows(["parent"]);
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: "b-1",
      index: 0,
      markdown: "one",
    });
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: "b-1",
      index: 1,
      markdown: "two",
    });
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(3));

    pressBullet(1);
    pressBullet(2, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Tab", shiftKey: true });

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["parent", "one", "two"]);
    });
  });

  it("clears on Escape and deletes on Backspace", async () => {
    const { session } = await mountRows(["one", "two"]);
    pressBullet(0);
    pressBullet(1, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Escape" });
    expect(selectedTexts()).toEqual([]);

    pressBullet(0);
    pressBullet(1, { shiftKey: true });
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Backspace" });
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks).toHaveLength(0);
    });
  });

  it("copies the covered hierarchy as an indented Markdown list", async () => {
    const { session } = await mountRows(["parent"]);
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: "b-1",
      index: 0,
      markdown: "child\ncontinuation",
    });
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(2));

    fireEvent.pointerDown(screen.getAllByTestId("row-grip")[0], {
      button: 0,
      clientX: 2,
      clientY: 10,
    });
    fireEvent.pointerUp(window, { button: 0, clientX: 2, clientY: 10 });
    expect(selectedTexts()).toEqual(["parent", "child\ncontinuation"]);

    const setData = vi.fn();
    fireEvent.copy(screen.getByRole("tree"), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      "- parent\n  - child\n    continuation",
    );
  });

  it("pastes a Markdown list as one undoable outline command", async () => {
    const { session, port } = await mountRows([""]);
    const commands: string[] = [];
    port.beforeExecute = async (command) => {
      commands.push(command.type);
    };

    fireEvent.paste(screen.getByLabelText("Block text"), {
      clipboardData: {
        getData: () => "- one\n  - two\n  - three\n- four",
      },
    });

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["one", "four"]);
      expect(page?.blocks[0].children.map((block) => block.markdown)).toEqual(["two", "three"]);
    });
    expect(commands).toEqual(["insert_outline"]);

    await session.execute({ type: "undo" });
    expect(
      session.getState().snapshot.pages.find((entry) => entry.id === "home")?.blocks,
    ).toMatchObject([{ markdown: "", children: [] }]);
  });
});
