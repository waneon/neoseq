// Outline keyboard mapping and IME safety on the virtualized tree.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { findPage } from "../../src/core-port/snapshot";
import { openFakeSession } from "../../src/core-port/testing/fake-core-port";
import { Outliner } from "../../src/features/outline/Outliner";
import { SessionContext } from "../../src/features/shell/session-context";
import { HistoryProvider } from "../../src/features/history/context";
import { GRAPH_ID, mountAt, openBlockMenu } from "./harness";

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

/** Lets the one deferred frame `releaseFocus` waits for actually run. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("outliner keyboard commands", () => {
  it("shows Markdown at rest and restores the source editor on activation", async () => {
    await mountOutline(["Read **bold** text", "plain"]);
    const user = userEvent.setup();
    const [markdownSource, plainSource] = screen.getAllByLabelText("Block text");

    expect(markdownSource).toHaveAttribute("hidden");
    expect(screen.getByText("bold").tagName).toBe("STRONG");

    await user.click(screen.getByTestId("block-markdown"));
    expect(markdownSource).not.toHaveAttribute("hidden");
    expect(markdownSource).toHaveFocus();
    expect(markdownSource).toHaveValue("Read **bold** text");

    await user.click(plainSource);
    await waitFor(() => expect(markdownSource).toHaveAttribute("hidden"));
    expect(screen.getByText("bold").tagName).toBe("STRONG");

    // The browser's dictionary has no entry for a page name or a property key.
    expect(markdownSource).toHaveAttribute("spellcheck", "false");
  });

  it("returns to the projection when focus leaves the row, but not for an overlay", async () => {
    await mountOutline(["Read **bold** text"]);
    const user = userEvent.setup();
    const source = screen.getByLabelText("Block text");

    await user.click(screen.getByTestId("block-markdown"));
    expect(source).not.toHaveAttribute("hidden");

    // The block's own menu takes focus out of the textarea and gives it straight
    // back, so the editor has to stay open underneath it — otherwise choosing
    // `Properties` re-rendered the row out from under the menu that was opening.
    await openBlockMenu(0);
    await settleFrame();
    expect(source).not.toHaveAttribute("hidden");
    await user.keyboard("{Escape}");
    await settleFrame();

    // A press on the quiet page around the writing focuses nothing at all, so a
    // blur is the only thing the row ever hears. It used to hear it and stay on
    // source forever, which meant the reading projection never came back.
    await act(async () => {
      screen.getByLabelText("Block text").blur();
    });
    await settleFrame();
    await waitFor(() =>
      expect(screen.getByLabelText("Block text")).toHaveAttribute("hidden"),
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

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

  it("keeps rapid input focused while a pending row adopts its real block id", async () => {
    const { session, port } = await openFakeSession("pending-handoff");
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "alpha",
    });
    const frozenPage = findPage(session.getState().snapshot, "home");
    if (!frozenPage) throw new Error("test page was not created");
    let releaseSplit = () => undefined;
    const splitGate = new Promise<void>((resolve) => {
      releaseSplit = resolve;
    });
    let signalSplitStarted = () => undefined;
    const splitStarted = new Promise<void>((resolve) => {
      signalSplitStarted = resolve;
    });
    let releaseIndent = () => undefined;
    const indentGate = new Promise<void>((resolve) => {
      releaseIndent = resolve;
    });
    let signalIndentStarted = () => undefined;
    const indentStarted = new Promise<void>((resolve) => {
      signalIndentStarted = resolve;
    });
    let pauseNextSplit = true;
    let pauseNextIndent = true;
    const commandTypes: string[] = [];
    port.beforeExecute = async (command) => {
      commandTypes.push(command.type);
      if (command.type === "split_block" && pauseNextSplit) {
        pauseNextSplit = false;
        signalSplitStarted();
        await splitGate;
      } else if (command.type === "indent_blocks" && pauseNextIndent) {
        pauseNextIndent = false;
        signalIndentStarted();
        await indentGate;
      }
    };

    // Model the real handoff race: GraphSession has reconciled the insert,
    // while the parent still holds the page object from the previous render.
    render(
      <MemoryRouter>
        <SessionContext.Provider value={session}>
          <HistoryProvider session={session} graphId="pending-handoff">
            <Outliner page={frozenPage} scrollElement={null} />
          </HistoryProvider>
        </SessionContext.Provider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Block text"));
    // Chain a second pending row while the first split is still in flight.
    await user.keyboard("{Enter}{Tab}child{Enter}");
    await splitStarted;
    await act(async () => {
      releaseSplit();
      await indentStarted;
    });
    // Queue a third row while the first pending row is replaying its indent.
    // The second split must wait, then resolve placement from the new tree.
    await user.keyboard("{Tab}grandchild{Enter}");
    await act(async () => {
      releaseIndent();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(4));
    expect(document.activeElement).toBe(screen.getAllByLabelText("Block text")[3]);
    await waitFor(() => {
      expect(commandTypes.filter((type) => type === "indent_blocks")).toHaveLength(2);
      const page = findPage(session.getState().snapshot, "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["alpha"]);
      expect(page?.blocks[0].children.map((block) => block.markdown)).toEqual(["child"]);
      expect(page?.blocks[0].children[0].children.map((block) => block.markdown)).toEqual([
        "grandchild",
        "",
      ]);
    });
  });

  it("Enter on an empty block inserts below and moves the caret there", async () => {
    const { session } = await mountOutline(["alpha", "", "omega"]);
    const user = userEvent.setup();
    const empty = screen.getAllByLabelText("Block text")[1];
    await user.click(empty);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(4));
    // The new block sits under the one Enter was pressed in, never above it.
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks.map((b) => b.markdown)).toEqual(["alpha", "", "", "omega"]);
    });
    expect(document.activeElement).toBe(screen.getAllByLabelText("Block text")[2]);
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
    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks.map((b) => b.markdown)).toEqual(["headtail"]);
    });
  });

  it("inserts before a leading caret and preserves the original block metadata", async () => {
    const { session } = await mountOutline(["alpha"]);
    const original = findPage(session.getState().snapshot, "home")!.blocks[0];
    await session.execute({
      type: "set_property",
      owner: { kind: "block", page_id: "home", id: original.id },
      key: "builtin.task-status",
      value: { type: "string", value: "doing" },
    });
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(0, 0);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const page = findPage(session.getState().snapshot, "home")!;
      expect(page.blocks.map((block) => block.markdown)).toEqual(["", "alpha"]);
      expect(page.blocks[1].id).toBe(original.id);
      expect(page.blocks[1].properties).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "builtin.task-status",
          values: [{ type: "string", value: "doing" }],
        }),
      ]));
    });

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      const page = findPage(session.getState().snapshot, "home")!;
      expect(page.blocks).toHaveLength(1);
      expect(page.blocks[0].id).toBe(original.id);
      expect(page.blocks[0].markdown).toBe("alpha");
      expect(page.blocks[0].properties).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "builtin.task-status" }),
      ]));
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

  it("reconciles a focused text draft after undo and redo", async () => {
    const { session } = await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    await user.keyboard("beta");
    await waitFor(() => {
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks[0].markdown).toBe("alphabeta");
    });

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      expect(textarea).toHaveValue("alpha");
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks[0].markdown).toBe("alpha");
    });

    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    await waitFor(() => {
      expect(textarea).toHaveValue("alphabeta");
      const page = session.getState().snapshot.pages.find((p) => p.id === "home");
      expect(page?.blocks[0].markdown).toBe("alphabeta");
    });
  });

  it("dismisses an open menu when the empty region below the writing is clicked", async () => {
    await mountOutline(["alpha"]);
    const menu = await openBlockMenu();
    expect(menu).toBeInTheDocument();

    // The region under the last block is both "make a block" and "the nearest
    // place with nothing on it", and the second reading has to win: this click
    // used to close the menu AND append an empty row nobody asked for, every
    // time anyone dismissed a block menu by clicking past it.
    const append = screen.getByTestId("outline-append");
    fireEvent.pointerDown(append);
    fireEvent.click(append);

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getAllByLabelText("Block text")).toHaveLength(1);

    // With nothing floating, the same target is a new block again.
    fireEvent.pointerDown(append);
    fireEvent.click(append);
    await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
  });
});
