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
      owner: { kind: "page", id: "home" },
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
      owner: { kind: "page", id: "home" },
      parent: "b-1",
      index: 0,
      markdown: "one",
    });
    await session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
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

  it("keeps selected passengers selected when undo separates them from their parent", async () => {
    const { session } = await mountRows(["eight", "two", "four"]);
    await session.execute({
      type: "move_blocks",
      owner: { kind: "page", id: "home" },
      block_ids: ["b-2", "b-3"],
      parent: "b-1",
      after: null,
    });
    await waitFor(() => expect(screen.getAllByRole("treeitem")).toHaveLength(3));

    // The range ends on the first child. The second child is nevertheless a
    // visible passenger of the selected parent and therefore part of what the
    // user selected.
    pressBullet(0);
    pressBullet(1, { shiftKey: true });
    expect(selectedTexts()).toEqual(["eight", "two", "four"]);

    await session.execute({ type: "undo" });
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["eight", "two", "four"]);
      expect(selectedTexts()).toEqual(["eight", "two", "four"]);
    });
  });

  it("select-all past the text selects the block itself", async () => {
    const user = userEvent.setup();
    await mountRows(["words", ""]);

    // In an empty block the first ⌘A already means the block.
    const empty = screen.getAllByLabelText("Block text")[1];
    await user.click(empty);
    await user.keyboard("{Meta>}a{/Meta}");
    expect(selectedTexts()).toEqual([""]);

    // With text, ⌘A widens: first the whole text (native), then the block.
    const full = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
    await user.click(full);
    full.setSelectionRange(0, full.value.length);
    fireEvent.keyDown(full, { key: "a", metaKey: true });
    expect(selectedTexts()).toEqual(["words"]);
  });

  it("drops the selection when quiet row space is clicked without dragging", async () => {
    await mountRows(["one", "two"]);
    pressBullet(0);
    pressBullet(1, { shiftKey: true });
    expect(selectedTexts()).toHaveLength(2);

    const row = screen.getAllByRole("treeitem")[0];
    fireEvent.pointerDown(row, { button: 0, clientX: 200, clientY: 10 });
    fireEvent.pointerUp(window, { button: 0, clientX: 200, clientY: 10 });
    expect(selectedTexts()).toEqual([]);
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
      owner: { kind: "page", id: "home" },
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

  it("pastes a mixed HTML flow before its lossy plain-text fallback", async () => {
    const { session, port } = await mountRows([""]);
    const commands: string[] = [];
    port.beforeExecute = async (command) => {
      commands.push(command.type);
    };

    fireEvent.paste(screen.getByLabelText("Block text"), {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return "Question?<ul><li>one<ol><li>two</li></ol></li><li>three</li></ul>";
          }
          if (type === "text/plain") return "Question?\none\ntwo\nthree";
          return "";
        },
      },
    });

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual([
        "Question?",
        "one",
        "three",
      ]);
      expect(page?.blocks[1].children.map((block) => block.markdown)).toEqual(["two"]);
    });
    expect(commands).toEqual(["insert_outline"]);
  });

  it("round-trips properties and tags through the rich clipboard fragment", async () => {
    const { session, port } = await mountRows(["source", ""]);
    await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });
    await session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "doing" },
    });
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));

    fireEvent.pointerDown(screen.getAllByTestId("row-grip")[0], {
      button: 0,
      clientX: 2,
      clientY: 10,
    });
    fireEvent.pointerUp(window, { button: 0, clientX: 2, clientY: 10 });
    expect(selectedTexts()).toEqual(["source"]);
    const values = new Map<string, string>();
    fireEvent.copy(screen.getByRole("tree"), {
      clipboardData: {
        setData: (type: string, value: string) => { values.set(type, value); },
      },
    });
    expect(values.get("text/plain")).toContain("Tags: #Project");
    expect(values.get("text/html")).toContain("data-neoseq-outline=");

    const commands: string[] = [];
    port.beforeExecute = async (command) => { commands.push(command.type); };
    fireEvent.paste(screen.getAllByLabelText("Block text")[1], {
      clipboardData: { getData: (type: string) => values.get(type) ?? "" },
    });

    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((entry) => entry.id === "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["source", "source"]);
      expect(page?.blocks[1].tags).toEqual(["project"]);
      expect(page?.blocks[1].properties).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "builtin.task-status",
          values: [{ type: "string", value: "doing" }],
        }),
      ]));
    });
    expect(commands).toEqual(["paste_outline"]);
  });
});
