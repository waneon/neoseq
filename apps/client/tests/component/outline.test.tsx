// Outline keyboard mapping and IME safety on the virtualized tree.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { findPage } from "../../src/core-port/snapshot";
import { resetAppSettingsCache, setEditorKeymap } from "../../src/entities/settings";
import { openFakeSession } from "../../src/core-port/testing/fake-core-port";
import { Outliner } from "../../src/features/outline/Outliner";
import { SessionContext } from "../../src/features/shell/session-context";
import { HistoryProvider } from "../../src/features/history/context";
import { NotifyProvider } from "../../src/features/notify/context";
import { LocaleProvider } from "../../src/i18n";
import { GRAPH_ID, mountAt, openBlockMenu, TestCommandProvider } from "./harness";

async function mountOutline(markdowns: string[] = ["alpha"]) {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session } = harness;
  await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  for (const [index, markdown] of markdowns.entries()) {
    await session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index,
      markdown,
    });
  }
  await waitFor(() =>
    expect(screen.queryAllByLabelText("Block text")).toHaveLength(markdowns.length),
  );
  return harness;
}

/** Lets the one deferred frame `releaseFocus` waits for actually run. */
async function settleFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function waitForPendingRowsToSettle(): Promise<void> {
  if (!document.querySelector('[data-block-id^="pending-"]')) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-block-id^="pending-"]')) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

describe("outliner keyboard commands", () => {
  it("enters Insert on the press, not on the click a paint later", async () => {
    setEditorKeymap("vim");
    try {
      await mountOutline(["alpha", "beta"]);
      const [first, second] = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];

      // A focus no press caused keeps the mode it found: this is how `j`, undo,
      // and a revealed history target arrive.
      await act(async () => {
        fireEvent.focus(second);
      });
      expect(second).toHaveAttribute("data-vim-mode", "normal");

      // A press is going to write. The browser hands that entrance over as a
      // bare `focus` and the `click` that would say a pointer caused it is one
      // paint later — which is one frame of the Normal-mode block caret sitting
      // in a line the reader is already typing into.
      await act(async () => {
        fireEvent.pointerDown(first);
        fireEvent.focus(first);
      });
      expect(first).toHaveAttribute("data-vim-mode", "insert");
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("uses one Vim session across block motion and structural edits", async () => {
    setEditorKeymap("vim");
    try {
      const { session } = await mountOutline(["one two", "middle", "second"]);
      const user = userEvent.setup();
      const first = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
      await user.click(first);
      first.setSelectionRange(0, 0);

      expect(first).not.toHaveAttribute("readonly");
      expect(first).toHaveAttribute("data-vim-mode", "insert");
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
      await user.keyboard("{Escape}");
      expect(first).toHaveAttribute("data-vim-mode", "normal");
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("NORMAL");
      await user.keyboard("w");
      expect([first.selectionStart, first.selectionEnd]).toEqual([4, 4]);

      await user.keyboard("i");
      await waitFor(() => expect(first).toHaveAttribute("data-vim-mode", "insert"));
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
      await user.keyboard("big ");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(first).toHaveAttribute("data-vim-mode", "normal"));
      await user.keyboard("0dw");
      expect(first).toHaveValue("big two");

      await act(async () => {
        fireEvent.keyDown(first, { key: "j" });
        await Promise.resolve();
      });
      const middle = screen.getAllByLabelText("Block text")[1] as HTMLTextAreaElement;
      await waitFor(() => expect(middle).toHaveFocus());
      expect(middle).toHaveAttribute("data-vim-mode", "normal");

      await user.keyboard(">>");
      await waitFor(() => {
        expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-level", "2");
      });

      await user.keyboard("dd");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks[0].children).toHaveLength(0);
      });
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("NORMAL");

      await user.keyboard("u");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks[0].children[0]?.markdown).toBe("middle");
      });
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("carries word motions and one undoable operator across block text", async () => {
    setEditorKeymap("vim");
    try {
      const { session } = await mountOutline(["one tail", "next words", "last"]);
      const user = userEvent.setup();
      const inputs = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];
      await user.click(inputs[0]);
      await user.keyboard("{Escape}");
      inputs[0].setSelectionRange(4, 4);

      await user.keyboard("2w");
      await waitFor(() => expect(inputs[1]).toHaveFocus());
      expect([inputs[1].selectionStart, inputs[1].selectionEnd]).toEqual([5, 5]);

      inputs[1].setSelectionRange(0, 0);
      await user.keyboard("b");
      await waitFor(() => expect(inputs[0]).toHaveFocus());
      expect([inputs[0].selectionStart, inputs[0].selectionEnd]).toEqual([4, 4]);

      inputs[0].setSelectionRange(7, 7);
      await user.keyboard("e");
      await waitFor(() => expect(inputs[1]).toHaveFocus());
      expect([inputs[1].selectionStart, inputs[1].selectionEnd]).toEqual([3, 3]);

      await user.click(inputs[0]);
      await user.keyboard("{Escape}");
      inputs[0].setSelectionRange(4, 4);
      await user.keyboard("d2w");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks.map((block) => block.markdown)).toEqual(["one ", "words", "last"]);
      });
      expect(findPage(session.getState().snapshot, "home")?.blocks).toHaveLength(3);

      await user.keyboard("u");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks.map((block) => block.markdown)).toEqual([
          "one tail",
          "next words",
          "last",
        ]);
      });

      const restored = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];
      await user.click(restored[1]);
      await user.keyboard("{Escape}");
      restored[1].setSelectionRange(1, 1);
      await user.keyboard("ciwfresh{Escape}");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks.map((block) => block.markdown)).toEqual([
          "one tail",
          "fresh words",
          "last",
        ]);
      });
      expect(findPage(session.getState().snapshot, "home")?.blocks).toHaveLength(3);
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("extends Visual Line across visible blocks and restores the caret at its head", async () => {
    setEditorKeymap("vim");
    try {
      await mountOutline(["one", "two", "three", "four"]);
      const user = userEvent.setup();
      const first = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
      await user.click(first);
      await user.keyboard("{Escape}");
      first.setSelectionRange(2, 2);

      await user.keyboard("V");
      await waitFor(() => expect(screen.getByRole("tree")).toHaveFocus());
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("VISUAL LINE");
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "true",
        "false",
        "false",
        "false",
      ]);

      await user.keyboard("2j");
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "true",
        "true",
        "true",
        "false",
      ]);
      await user.keyboard("k");
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "true",
        "true",
        "false",
        "false",
      ]);
      await user.keyboard("G");
      expect(screen.getAllByRole("treeitem").every((row) => row.dataset.selected === "true"))
        .toBe(true);
      await user.keyboard("gg");
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "true",
        "false",
        "false",
        "false",
      ]);
      await user.keyboard("G");
      await user.keyboard("V");

      const fourth = screen.getAllByLabelText("Block text")[3] as HTMLTextAreaElement;
      await waitFor(() => expect(fourth).toHaveFocus());
      expect(fourth).toHaveAttribute("data-vim-mode", "normal");
      expect([fourth.selectionStart, fourth.selectionEnd]).toEqual([2, 2]);
      expect(screen.getAllByRole("treeitem").every((row) => row.dataset.selected === "false"))
        .toBe(true);
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("moves Visual Line past descendants already covered by the selection", async () => {
    setEditorKeymap("vim");
    try {
      const { session } = await mountOutline(["A", "D"]);
      const page = findPage(session.getState().snapshot, "home")!;
      const child = await session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: page.blocks[0].id,
        index: 0,
        markdown: "B",
      });
      await session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: child.created_block,
        index: 0,
        markdown: "C",
      });
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(4));

      const user = userEvent.setup();
      const first = screen.getAllByLabelText("Block text")[0] as HTMLTextAreaElement;
      await user.click(first);
      await user.keyboard("{Escape}V");
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "true",
        "true",
        "true",
        "false",
      ]);

      await user.keyboard("j");
      expect(screen.getAllByRole("treeitem").every((row) => row.dataset.selected === "true"))
        .toBe(true);

      await user.keyboard("kV");
      await waitFor(() => expect(first).toHaveFocus());
      expect(screen.getAllByRole("treeitem").map((row) => row.dataset.selected)).toEqual([
        "false",
        "false",
        "false",
        "false",
      ]);
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("leaves Visual Line through pointer editing and structural actions", async () => {
    setEditorKeymap("vim");
    try {
      const { session } = await mountOutline(["root", "two", "three", "tail"]);
      const user = userEvent.setup();
      const inputs = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];
      await user.click(inputs[1]);
      await user.keyboard("{Escape}Vj");
      expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("data-selected", "true");
      expect(screen.getAllByRole("treeitem")[2]).toHaveAttribute("data-selected", "true");

      await user.click(inputs[3]);
      expect(inputs[3]).toHaveAttribute("data-vim-mode", "insert");
      expect(screen.getAllByRole("treeitem").every((row) => row.dataset.selected === "false"))
        .toBe(true);

      await user.click(inputs[1]);
      await user.keyboard("{Escape}Vj>");
      await waitFor(() => {
        expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-level", "2");
        expect(screen.getAllByRole("treeitem")[2]).toHaveAttribute("aria-level", "2");
      });
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("NORMAL");

      await user.keyboard("Vk");
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("VISUAL LINE");
      await user.keyboard("d");
      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks.map((block) => block.markdown)).toEqual(["root", "tail"]);
        expect(page?.blocks[0].children).toHaveLength(0);
      });
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("NORMAL");
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("keeps IME input behind the Vim mode boundary", async () => {
    setEditorKeymap("vim");
    try {
      await mountOutline(["한"]);
      const user = userEvent.setup();
      const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
      await user.click(textarea);
      await user.keyboard("{Escape}");

      // A few browser/IME combinations deliver a non-cancelable composition
      // input even when beforeinput was rejected. Normal mode restores the
      // DOM value before React can turn it into a graph edit.
      fireEvent.compositionStart(textarea);
      textarea.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        data: "글",
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      textarea.setRangeText("글", 1, 1, "end");
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: "글",
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      fireEvent.compositionEnd(textarea, { data: "글" });
      expect(textarea).toHaveValue("한");

      await user.keyboard("i");
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: "Escape", isComposing: true, keyCode: 229 });
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
      fireEvent.compositionEnd(textarea);
      await user.keyboard("{Escape}");
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("NORMAL");
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("opens outline units into Vim Insert mode", async () => {
    setEditorKeymap("vim");
    try {
      const { session } = await mountOutline(["anchor"]);
      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Block text"));
      await user.keyboard("{Escape}");

      await user.keyboard("o");
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
      await user.keyboard("below{Escape}");

      await user.keyboard("O");
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(3));
      await user.keyboard("between{Escape}");

      await waitFor(() => {
        const page = findPage(session.getState().snapshot, "home");
        expect(page?.blocks.map((block) => block.markdown)).toEqual([
          "anchor",
          "between",
          "below",
        ]);
      });
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("enters Vim Insert mode for every pointer-driven block creation", async () => {
    setEditorKeymap("vim");
    try {
      await mountOutline([]);
      const user = userEvent.setup();

      await user.click(screen.getByTestId("outline-start"));
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(1));
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");

      await user.keyboard("{Escape}");
      await user.click(screen.getByTestId("outline-append"));
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(2));
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");

      await user.keyboard("{Escape}");
      await openBlockMenu(0);
      await user.click(screen.getByRole("menuitem", { name: "Add child block" }));
      await waitFor(() => expect(screen.getAllByLabelText("Block text")).toHaveLength(3));
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("enters Vim Insert mode when a pointer opens rendered Markdown", async () => {
    setEditorKeymap("vim");
    try {
      await mountOutline(["Read **bold** text"]);
      const user = userEvent.setup();

      await user.click(screen.getByTestId("block-markdown"));

      expect(screen.getByLabelText("Block text")).toHaveFocus();
      expect(screen.getByTestId("vim-mode-indicator")).toHaveTextContent("INSERT");
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

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

  it("flushes the final debounced edit when the outline unmounts", async () => {
    const { session, view } = await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " beta");

    view.unmount();

    await waitFor(() => {
      const page = findPage(session.getState().snapshot, "home");
      expect(page?.blocks[0].markdown).toBe("alpha beta");
    });
  });

  it("auto-pairs delimiters, steps across closers, and deletes empty pairs", async () => {
    const { session } = await mountOutline([""]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);

    await user.keyboard("(");
    expect(textarea).toHaveValue("()");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 1]);

    await user.keyboard("x");
    expect(textarea).toHaveValue("(x)");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);
    await user.keyboard("{Backspace}");

    await user.keyboard(")");
    expect(textarea).toHaveValue("()");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 2]);

    textarea.setSelectionRange(1, 1);
    await user.keyboard("{Backspace}");
    expect(textarea).toHaveValue("");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 0]);

    await user.keyboard("[[");
    await user.tab({ shift: true });
    await waitFor(() => {
      const page = findPage(session.getState().snapshot, "home");
      expect(page?.blocks[0].markdown).toBe("[]");
    });
  });

  it("wraps selected block text and keeps it selected", async () => {
    await mountOutline(["alpha"]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(0, textarea.value.length, "backward");

    await user.keyboard("[[");

    expect(textarea).toHaveValue("[alpha]");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 6]);
    expect(textarea.selectionDirection).toBe("backward");
  });

  it("overtype-repairs a Korean IME closer without mutating the live composition", async () => {
    await mountOutline([""]);
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    await user.keyboard("[[");

    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    const compositionInput = (data: string, next: string, caret: number) => {
      const beforeInput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        data,
        inputType: "insertCompositionText",
        isComposing: true,
      });
      expect(textarea.dispatchEvent(beforeInput)).toBe(true);
      setNativeValue.call(textarea, next);
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
    };

    await act(async () => {
      fireEvent.compositionStart(textarea);
      compositionInput("안녕", "[안녕]", 3);
      compositionInput("]", "[안녕]]", 4);
      fireEvent.compositionEnd(textarea, { data: "]" });
    });

    expect(textarea).toHaveValue("[안녕]");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 4]);

    // The repair keeps provenance on the surviving generated closer, so a
    // later IME overtype at the same boundary is safe as well.
    textarea.setSelectionRange(3, 3);
    await act(async () => {
      fireEvent.compositionStart(textarea);
      compositionInput("]", "[안녕]]", 4);
      fireEvent.compositionEnd(textarea, { data: "]" });
    });
    expect(textarea).toHaveValue("[안녕]");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([4, 4]);
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
      owner: { kind: "page", id: "home" },
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
      <LocaleProvider initialPreference="en">
        <NotifyProvider>
          <MemoryRouter>
            <TestCommandProvider>
              <SessionContext.Provider value={session}>
                <HistoryProvider session={session} graphId="pending-handoff">
                  <Outliner
                    owner={{ kind: "page", id: frozenPage.id }}
                    blocks={frozenPage.blocks}
                    scrollElement={null}
                  />
                </HistoryProvider>
              </SessionContext.Provider>
            </TestCommandProvider>
          </MemoryRouter>
        </NotifyProvider>
      </LocaleProvider>,
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

  it("projects both halves exactly once while a middle split is in flight", async () => {
    const { session, port } = await mountOutline(["headtail"]);
    let releaseSplit = () => undefined;
    const splitGate = new Promise<void>((resolve) => {
      releaseSplit = resolve;
    });
    let signalSplitStarted = () => undefined;
    const splitStarted = new Promise<void>((resolve) => {
      signalSplitStarted = resolve;
    });
    port.beforeExecute = async (command) => {
      if (command.type !== "split_block") return;
      signalSplitStarted();
      await splitGate;
    };

    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(4, 4);
    await user.keyboard("{Enter}");
    await act(async () => splitStarted);

    const pending = screen.getAllByLabelText("Block text") as HTMLTextAreaElement[];
    expect(pending.map((input) => input.value)).toEqual(["head", "tail"]);

    const adopted = waitForPendingRowsToSettle();
    await act(async () => {
      releaseSplit();
      await adopted;
    });
    await waitFor(() => {
      const page = findPage(session.getState().snapshot, "home");
      expect(page?.blocks.map((block) => block.markdown)).toEqual(["head", "tail"]);
    });
    port.beforeExecute = null;
    expect((screen.getAllByLabelText("Block text") as HTMLTextAreaElement[])
      .map((input) => input.value)).toEqual(["head", "tail"]);
  });

  it("removes the complete split projection when the canonical split fails", async () => {
    const { port } = await mountOutline(["headtail"]);
    let rejectSplit = () => undefined;
    const splitGate = new Promise<void>((resolve) => {
      rejectSplit = resolve;
    });
    let signalSplitStarted = () => undefined;
    const splitStarted = new Promise<void>((resolve) => {
      signalSplitStarted = resolve;
    });
    port.beforeExecute = async (command) => {
      if (command.type !== "split_block") return;
      signalSplitStarted();
      await splitGate;
      throw new Error("split rejected");
    };

    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text") as HTMLTextAreaElement;
    await user.click(textarea);
    textarea.setSelectionRange(4, 4);
    await user.keyboard("{Enter}");
    await act(async () => splitStarted);
    expect((screen.getAllByLabelText("Block text") as HTMLTextAreaElement[])
      .map((input) => input.value)).toEqual(["head", "tail"]);

    const restored = waitForPendingRowsToSettle();
    await act(async () => {
      rejectSplit();
      await restored;
    });
    expect(screen.getAllByLabelText("Block text")).toHaveLength(1);
    expect(screen.getByLabelText("Block text")).toHaveValue("headtail");
  });

  it("inserts before a leading caret and preserves the original block metadata", async () => {
    const { session } = await mountOutline(["alpha"]);
    const original = findPage(session.getState().snapshot, "home")!.blocks[0];
    await session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: original.id },
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

  it("keeps a completed page reference semantic and reprojects a focused draft on rename", async () => {
    const { session } = await mountOutline(["See "]);
    await act(async () => {
      await session.execute({ type: "ensure_page", page_id: "roadmap", title: "Roadmap" });
    });
    const user = userEvent.setup();
    const textarea = screen.getByLabelText("Block text");
    await user.click(textarea);
    // user-event escapes one literal `[` as `[[`; this sends two real openers.
    await user.keyboard("[[[[Road");

    const menu = await screen.findByTestId("page-reference-menu");
    expect(menu).toHaveTextContent("Roadmap");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      const block = findPage(session.getState().snapshot, "home")?.blocks[0];
      expect(block?.markdown).toBe("See [[Roadmap]]");
      expect(block?.page_references).toEqual([expect.objectContaining({ page_id: "roadmap" })]);
    });

    await user.type(textarea, " soon");
    await act(async () => {
      await session.execute({ type: "rename_page", page_id: "roadmap", title: "Plan" });
    });
    await waitFor(() => expect(textarea).toHaveValue("See [[Plan]] soon"));
    await waitFor(() => {
      const block = findPage(session.getState().snapshot, "home")?.blocks[0];
      expect(block?.markdown).toBe("See [[Plan]] soon");
      expect(block?.page_references).toEqual([expect.objectContaining({
        page_id: "roadmap",
        start: 4,
        end: 12,
      })]);
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
