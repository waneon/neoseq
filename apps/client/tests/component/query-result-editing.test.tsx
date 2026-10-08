import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CorePortFailure } from "../../src/core-worker";
import { stringValue } from "../../src/core-port/snapshot";
import { decodePlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";
import { resetAppSettingsCache, setEditorKeymap } from "../../src/entities/settings";
import { chooseFromMenu, GRAPH_ID } from "./harness";
import {
  storedQuery,
  activeDefinition,
  storedDefinition,
  lastBuiltQuery,
  withResult,
  resultBlock,
  addSecondResult,
} from "./query-support";

describe("query result editing", () => {
  it("renders a block result from its canonical snapshot through the shared block presentation", async () => {
    const harness = await withResult("Stale RDF text");
    const owner = {
      kind: "block" as const,
      owner: { kind: "page" as const, id: "home" },
      id: harness.resultBlockId,
    };
    await harness.settle(async () => {
      await harness.session.execute({
        type: "edit_markdown",
        owner: { kind: "page", id: "home" },
        block_id: harness.resultBlockId,
        markdown: "Canonical **block** text",
      });
      await harness.session.execute({
        type: "set_property",
        owner,
        key: "builtin.task-status",
        value: { type: "string", value: "done" },
      });
      await harness.session.execute({
        type: "set_property",
        owner,
        key: "builtin.task-priority",
        value: { type: "string", value: "high" },
      });
      await harness.session.execute({
        type: "set_property",
        owner,
        key: "user.owner",
        value: { type: "string", value: "Ada" },
      });
      // A repeated field stays one entity row in either layout. The list reads
      // that same selected block through its canonical presentation.
      const tableDocument = storedQuery(harness)!;
      const tablePlan = decodePlan(
        activeDefinition(tableDocument).plan!.payload,
        activeDefinition(tableDocument).plan!.version,
      )!;
      const aggregatePlan = {
        ...tablePlan,
        columns: [...tablePlan.columns, { id: "tags", source: { kind: "tags" as const } }],
      };
      await harness.session.execute({
        type: "set_query_plan",
        owner: {
          kind: "block",
          owner: { kind: "page", id: "home" },
          id: harness.queryBlockId,
        },
        view_id: "all",
        plan: { version: QUERY_PLAN_VERSION, payload: JSON.stringify(aggregatePlan) },
      });
      const nestedPlan = storedDefinition(harness)!.plan!;
      await harness.session.execute({
        type: "set_query_plan",
        owner,
        view_id: "all",
        plan: nestedPlan,
      });
    });

    const user = userEvent.setup();
    const hostQuery = screen.getAllByTestId("query-block")[0];
    await chooseFromMenu(user, within(hostQuery).getByTestId("query-view-trigger"), "List");
    await harness.settle(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await waitFor(() => {
      const executed = lastBuiltQuery(harness);
      expect(executed).toMatchObject({ kind: "built", plan: { grain: "entity" } });
      expect(executed).not.toHaveProperty("projection");
    });
    const row = within(await within(hostQuery).findByTestId("query-list")).getByTestId(
      "query-list-row",
    );
    expect(row).toHaveClass("block-row");
    expect(row.querySelector(".block-body")).not.toBeNull();
    expect(row.querySelector(".query-block-content .outline-markdown")).not.toBeNull();
    expect(row).toHaveTextContent("Canonical block text");
    expect(row).not.toHaveTextContent("Stale RDF text");
    expect(row.querySelector('[data-status-glyph="done"]')).not.toBeNull();
    expect(row.querySelector('[data-priority-glyph="high"]')).not.toBeNull();
    expect(within(row).getByTestId("prop-user.owner")).toHaveTextContent("Ada");
    expect(row.querySelector(".query-list-facts")).toBeNull();
    // A list is the block's inline representation, not its embedded feature
    // subtree: otherwise a result query would recursively mount another query.
    expect(within(row).queryByTestId("query-block")).not.toBeInTheDocument();
    expect(within(row).queryByTestId("prop-builtin.query")).not.toBeInTheDocument();
  });

  it("edits canonical block text directly from the table result", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    const settled = within(table).getByTestId("query-edit-text");
    expect(settled.tagName).toBe("TEXTAREA");
    await user.click(settled);
    const editor = await screen.findByTestId("query-markdown-editor");
    expect(editor).toBe(settled);
    expect(editor).toHaveValue("Ship the builder");
    await user.clear(editor);
    await user.type(editor, "Ship the editable result");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship the editable result"));
    await waitFor(() =>
      expect(screen.queryByTestId("query-markdown-editor")).not.toBeInTheDocument(),
    );
  });

  it("uses the shared Vim text grammar without exposing outline structure", async () => {
    const harness = await withResult();
    await act(async () => setEditorKeymap("vim"));
    try {
      const user = userEvent.setup();
      const table = await screen.findByTestId("query-table");
      const settled = within(table).getByTestId("query-edit-text");
      const previousModes: Array<string | null> = [];
      const modeChanges = new MutationObserver((records) => {
        previousModes.push(...records.map((record) => record.oldValue));
      });
      modeChanges.observe(settled, {
        attributes: true,
        attributeFilter: ["data-vim-mode"],
        attributeOldValue: true,
      });
      await user.click(settled);
      const editor = (await screen.findByTestId("query-markdown-editor")) as HTMLTextAreaElement;
      await Promise.resolve();
      modeChanges.disconnect();

      expect(editor).not.toHaveAttribute("readonly");
      // The caret carries the mode here and nothing else does: a badge under a
      // cell would grow its row and announce a mode beside a value the reader
      // had only meant to correct.
      expect(editor).toHaveAttribute("data-vim-mode", "insert");
      // Focus precedes click. The shared pointer entrance must still make the
      // first active render Insert; a Normal commit here is a visible flash.
      expect(previousModes).not.toContain("normal");
      expect(screen.queryByTestId("query-vim-mode-indicator")).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(editor).toHaveAttribute("data-vim-mode", "normal");
      editor.setSelectionRange(0, 0);
      await user.keyboard("V");
      expect(editor).toHaveAttribute("data-vim-mode", "normal");
      await user.keyboard("o");
      expect(editor).toHaveAttribute("data-vim-mode", "normal");
      expect(editor).toHaveValue("Ship the builder");
      await user.keyboard("A");
      await waitFor(() => expect(editor).toHaveAttribute("data-vim-mode", "insert"));
      await user.keyboard(" now{Escape}");
      await user.keyboard("0dw");
      expect(editor).toHaveValue("the builder now");
      await user.keyboard("ciwThat{Escape}");
      expect(editor).toHaveValue("That builder now");

      await user.click(screen.getByRole("button", { name: "Collapse 1 result" }));
      await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("That builder now"));
    } finally {
      localStorage.clear();
      resetAppSettingsCache();
    }
  });

  it("saves an active result edit before folding the answer", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    await user.clear(editor);
    await user.type(editor, "Keep this before folding");
    await user.click(screen.getByRole("button", { name: "Collapse 1 result" }));

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Keep this before folding"));
    expect(screen.getByTestId("query-output")).toHaveAttribute("hidden");
    expect(screen.queryByTestId("query-markdown-editor")).not.toBeInTheDocument();
  });

  it("saves the final result draft when navigation unmounts its query", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");

    // Router-driven navigation does not deliver a native blur to a removed
    // textarea. The coordinator owns this final write before its debounce runs.
    await act(async () => {
      fireEvent.change(editor, { target: { value: "Ship it before leaving" } });
      await harness.router.navigate(`/g/${GRAPH_ID}/custom`);
    });

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it before leaving"));
  });

  it("drains newer result input after a pending save when navigation removes the editor", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content" || saving) return;
      saving = true;
      await pending;
    };

    fireEvent.change(editor, { target: { value: "First save" } });
    await waitFor(() => expect(saving).toBe(true));
    await act(async () => {
      fireEvent.change(editor, { target: { value: "First save plus final input" } });
      await harness.router.navigate(`/g/${GRAPH_ID}/custom`);
      release();
    });

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("First save plus final input"));
  });

  it("drains newer input before switching results during a pending save", async () => {
    const harness = await withResult("First result");
    await addSecondResult(harness);
    const user = userEvent.setup();
    const fields = within(screen.getByTestId("query-table")).getAllByTestId("query-edit-text");
    await user.click(fields[0]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content" || saving) return;
      saving = true;
      await pending;
    };
    fireEvent.change(fields[0], { target: { value: "First save" } });
    await waitFor(() => expect(saving).toBe(true));
    fireEvent.change(fields[0], { target: { value: "First save plus newer input" } });
    await user.click(fields[1]);
    await harness.settle(async () => {
      const finalWrite = new Promise<void>((resolve) => {
        const unsubscribe = harness.session.subscribe(() => {
          if (resultBlock(harness)?.markdown !== "First save plus newer input") return;
          unsubscribe();
          resolve();
        });
      });
      release();
      await finalWrite;
    });
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("First save plus newer input"));
    await waitFor(() => expect(screen.getByTestId("query-markdown-editor")).toBe(fields[1]));
  });

  it("keeps a rejected pending draft and retry visible when another result is requested", async () => {
    const harness = await withResult("First result");
    await addSecondResult(harness);
    const user = userEvent.setup();
    const fields = within(screen.getByTestId("query-table")).getAllByTestId("query-edit-text");
    await user.click(fields[0]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content") return;
      saving = true;
      await pending;
      harness.port.beforeExecute = null;
      throw new CorePortFailure({
        code: "invalid_request",
        message: "rejected edit",
        retryable: false,
      });
    };
    fireEvent.change(fields[0], { target: { value: "Keep my pending correction" } });
    await waitFor(() => expect(saving).toBe(true));
    await user.click(fields[1]);
    await harness.settle(() => release());
    const error = await screen.findByRole("alert");
    expect(fields[0]).toHaveValue("Keep my pending correction");
    expect(resultBlock(harness)?.markdown).toBe("First result");
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Keep my pending correction"));
  });

  it("keeps picker completion and its draft while a prior save is pending or rejected", async () => {
    const harness = await withResult("First result");
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content") return;
      saving = true;
      await pending;
      harness.port.beforeExecute = null;
      throw new CorePortFailure({
        code: "invalid_request",
        message: "rejected edit",
        retryable: false,
      });
    };
    try {
      fireEvent.change(editor, { target: { value: "First save" } });
      await waitFor(() => expect(saving).toBe(true));
      await user.type(editor, " plus /properties");
      const menu = await screen.findByTestId("slash-menu");
      await user.keyboard("{Enter}");
      expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
      expect(editor).toHaveValue("First save plus /properties");
      expect(menu).toBeInTheDocument();
      const option = within(menu).getByRole("option", { name: /Add property/ });
      expect(option).toHaveAttribute("aria-disabled", "true");
      expect(option).toHaveTextContent("Saving");
      await user.click(option);
      expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
      expect(editor).toHaveValue("First save plus /properties");
      await harness.settle(() => release());
      const error = await screen.findByRole("alert");
      expect(editor).toHaveValue("First save plus /properties");
      expect(resultBlock(harness)?.markdown).toBe("First result");
      expect(option).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
      await user.keyboard("{Escape}");
      await user.click(within(error).getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(resultBlock(harness)?.markdown).toBe("First save plus /properties"),
      );
    } finally {
      await harness.settle(() => release());
    }
  });

  it.each([
    { token: "/done", menu: "slash-menu", option: /^Done/ },
    { token: "#pro", menu: "tag-menu", option: /^Project/ },
  ])(
    "preserves $token until a rejected earlier save has been retried",
    async ({ token, menu, option }) => {
      const harness = await withResult("First result");
      await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
      const user = userEvent.setup();
      await user.click(
        within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
      );
      const editor = await screen.findByTestId("query-markdown-editor");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let saving = false;
      harness.port.beforeExecute = async (command) => {
        if (command.type !== "splice_block_content") return;
        saving = true;
        await pending;
        harness.port.beforeExecute = null;
        throw new CorePortFailure({
          code: "invalid_request",
          message: "rejected edit",
          retryable: false,
        });
      };
      try {
        fireEvent.change(editor, { target: { value: "First save" } });
        await waitFor(() => expect(saving).toBe(true));
        await user.type(editor, ` more ${token}`);
        const completion = await screen.findByTestId(menu);
        await user.keyboard("{Enter}");
        expect(editor).toHaveValue(`First save more ${token}`);
        expect(completion).toBeInTheDocument();
        const choice = within(completion).getByRole("option", { name: option });
        expect(choice).toHaveAttribute("aria-disabled", "true");
        await user.click(choice);
        expect(editor).toHaveValue(`First save more ${token}`);
        await harness.settle(() => release());
        const error = await screen.findByRole("alert");
        await user.keyboard("{Enter}");
        expect(editor).toHaveValue(`First save more ${token}`);
        expect(choice).toHaveAttribute("aria-disabled", "true");
        expect(resultBlock(harness)?.markdown).toBe("First result");
        expect(resultBlock(harness)?.tags).not.toContain("project");
        expect(
          stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status"),
        ).toBeUndefined();
        await user.keyboard("{Escape}");
        await user.click(within(error).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
          expect(resultBlock(harness)?.markdown).toBe(`First save more ${token}`),
        );
        // Retry saves text. Only an explicit, now-available choice applies the
        // semantic action; a rejected predecessor must not silently enqueue it.
        await user.click(editor);
        await user.keyboard("{End}{Backspace}");
        await user.keyboard(token.at(-1)!);
        const available = within(await screen.findByTestId(menu)).getByRole("option", {
          name: option,
        });
        expect(available).not.toHaveAttribute("aria-disabled", "true");
        await user.click(available);
        await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("First save more"));
        if (token === "/done") {
          expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe(
            "done",
          );
        } else {
          expect(resultBlock(harness)?.tags).toContain("project");
        }
      } finally {
        await harness.settle(() => release());
      }
    },
  );

  it("keeps an open completion out of an earlier save's automatic drain", async () => {
    const harness = await withResult("First result");
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content" || saving) return;
      saving = true;
      await pending;
    };
    try {
      fireEvent.change(editor, { target: { value: "First save" } });
      await waitFor(() => expect(saving).toBe(true));
      await user.type(editor, " /done");
      const menu = await screen.findByTestId("slash-menu");
      await harness.settle(async () => {
        const firstWrite = new Promise<void>((resolve) => {
          const unsubscribe = harness.session.subscribe(() => {
            if (resultBlock(harness)?.markdown !== "First save") return;
            unsubscribe();
            resolve();
          });
        });
        release();
        await firstWrite;
      });
      await waitFor(() =>
        expect(editor.closest(".query-result-editor")).not.toHaveAttribute("data-saving", "true"),
      );
      expect(resultBlock(harness)?.markdown).toBe("First save");
      expect(editor).toHaveValue("First save /done");
      expect(menu).toBeInTheDocument();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe(
          "done",
        ),
      );
      await user.keyboard("{Meta>}z{/Meta}");
      await waitFor(() =>
        expect(
          stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status"),
        ).toBeUndefined(),
      );
      expect(resultBlock(harness)?.markdown).toBe("First save");
    } finally {
      await harness.settle(() => release());
    }
  });

  it("drains text typed after page completion when navigation removes the result", async () => {
    const harness = await withResult("See ");
    await harness.session.execute({ type: "ensure_page", page_id: "roadmap", title: "Roadmap" });
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content" || saving) return;
      saving = true;
      await pending;
    };
    await user.keyboard("[[[[Road");
    await screen.findByTestId("page-reference-menu");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saving).toBe(true));
    expect(editor).toHaveValue("See [[Roadmap]]");
    await user.type(editor, " soon");
    await act(async () => {
      await harness.router.navigate(`/g/${GRAPH_ID}/custom`);
      release();
    });
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("See [[Roadmap]] soon"));
    expect(resultBlock(harness)?.page_references).toEqual([
      expect.objectContaining({ page_id: "roadmap" }),
    ]);
  });

  it("retries a rejected page completion without losing its semantic target or newer text", async () => {
    const harness = await withResult("See ");
    await harness.session.execute({ type: "ensure_page", page_id: "roadmap", title: "Roadmap" });
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content") return;
      saving = true;
      await pending;
      harness.port.beforeExecute = null;
      throw new CorePortFailure({
        code: "invalid_request",
        message: "rejected completion",
        retryable: false,
      });
    };
    await user.keyboard("[[[[Road");
    await screen.findByTestId("page-reference-menu");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(saving).toBe(true));
    await user.type(editor, " soon");
    await harness.settle(() => release());
    const error = await screen.findByRole("alert");
    expect(editor).toHaveValue("See [[Roadmap]] soon");
    expect(resultBlock(harness)?.markdown).toBe("See ");
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("See [[Roadmap]] soon"));
    expect(resultBlock(harness)?.page_references).toEqual([
      expect.objectContaining({ page_id: "roadmap" }),
    ]);
  });
});
