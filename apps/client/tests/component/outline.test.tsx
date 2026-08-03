// Outline keyboard mapping and IME safety on the virtualized tree.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

async function mountOutline(markdowns: string[] = ["alpha"]) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session } = harness;
  await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  for (const [index, markdown] of markdowns.entries()) {
    await session.execute({
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

describe("outliner keyboard commands", () => {
  it("flushes text edits as splices on blur", async () => {
    const { session } = await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " beta");
    await user.tab({ shift: true }); // blur without structural command
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks[0].markdown).toBe("alpha beta");
    });
  });

  it("Enter inserts a sibling and focuses it; Tab indents; Shift+Tab outdents", async () => {
    await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
    const rows = screen.getAllByRole("treeitem");
    expect(rows[1]).toHaveAttribute("aria-level", "1");
    expect(document.activeElement).toBe(screen.getAllByLabelText("Block text")[1]);

    await user.keyboard("{Tab}");
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-level", "2"),
    );

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-level", "1"),
    );
  });

  it("splits the block when Enter is pressed mid-text", async () => {
    const { session } = await mountOutline(["headtail"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(4, 4);
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks.map((b) => b.markdown)).toEqual(["head", "tail"]);
    });
  });

  it("never lets block commands interrupt an IME composition", async () => {
    const { session } = await mountOutline(["한글"]);
    const textarea = screen.getByLabelText("Block text");
    fireEvent.focus(textarea);
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "한글입" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true, keyCode: 229 });
    // Still one block: composition boundary was preserved.
    expect(screen.getAllByLabelText("Block text")).toHaveLength(1);
    fireEvent.compositionEnd(textarea);
    fireEvent.blur(textarea);
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks[0].markdown).toBe("한글입");
      expect(page?.blocks).toHaveLength(1);
    });
  });

  it("deletes an empty block with Backspace and moves within siblings with Alt+Arrows", async () => {
    const { session } = await mountOutline(["one", "two", ""]);
    const user = userEvent.setup();
    const empty = screen.getAllByLabelText("Block text")[2];
    await user.click(empty);
    await user.keyboard("{Backspace}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));

    const first = screen.getAllByLabelText("Block text")[0];
    await user.click(first);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks.map((b) => b.markdown)).toEqual(["two", "one"]);
    });
  });

  it("undo and redo run through the core command path", async () => {
    const { session } = await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(1));
    // Undo removed the focused block; refocus the outline before redoing.
    await user.click(screen.getByLabelText("Block text"));
    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
  });
});
