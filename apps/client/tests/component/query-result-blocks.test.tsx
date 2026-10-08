import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CorePortFailure } from "../../src/core-worker";
import { findPage, stringValue } from "../../src/core-port/snapshot";
import { decodePlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";
import { chooseFromMenu } from "./harness";
import {
  CommandContext,
  createContextualHandlerRegistry,
  type CommandBridge,
  type PageActions,
} from "../../src/features/commands/context";
import { PageView } from "../../src/features/page/PageView";
import { storedQuery, activeDefinition, withResult, resultBlock } from "./query-support";

function commandBridge(): CommandBridge {
  const blocks = createContextualHandlerRegistry<(key?: string) => void>();
  let pageProperties: ((key?: string) => void) | null = null;
  let pageActions: PageActions | null = null;
  return {
    openPalette: () => {},
    openShortcuts: () => {},
    openSettings: () => {},
    registerBlockProperties: (handler) => blocks.register(handler),
    setPageProperties: (handler) => {
      pageProperties = handler;
    },
    setPageActions: (actions) => {
      pageActions = actions;
    },
    requestProperties: (key) => {
      const handler = blocks.current() ?? pageProperties;
      if (!handler) return false;
      handler(key);
      return true;
    },
    requestPageInfo: () => pageActions?.info(),
    requestPageDelete: () => pageActions?.remove(),
  };
}

describe("query result blocks", () => {
  it("waits for a pending result save before document undo", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedUndo!: () => void;
    const undoStarted = new Promise<void>((resolve) => {
      startedUndo = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type === "undo") startedUndo();
      if (command.type !== "splice_block_content" || saving) return;
      saving = true;
      await pending;
    };

    fireEvent.change(editor, { target: { value: "Ship it now" } });
    await waitFor(() => expect(saving).toBe(true));
    await user.keyboard("{Meta>}z{/Meta}");
    await harness.settle(async () => {
      release();
      await undoStarted;
    });

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => expect(editor).toHaveValue("Ship it"));
  });

  it("keeps a rejected result draft available for an explicit retry", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content") return;
      harness.port.beforeExecute = null;
      throw new CorePortFailure({
        code: "invalid_request",
        message: "rejected edit",
        retryable: false,
      });
    };

    fireEvent.change(editor, { target: { value: "Keep my correction" } });
    await user.keyboard("{Enter}");
    const error = await screen.findByRole("alert");
    expect(editor).toHaveValue("Keep my correction");
    expect(resultBlock(harness)?.markdown).toBe("Ship it");
    await user.click(within(error).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Keep my correction"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the canonical block input pipeline inside query results", async () => {
    await withResult("");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = (await screen.findByTestId("query-markdown-editor")) as HTMLTextAreaElement;
    await user.keyboard("(");

    expect(editor).toHaveValue("()");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 1]);
  });

  it("cycles a query result's task with Command+Enter while preserving its text and focus", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    fireEvent.change(editor, { target: { value: "Ship it today" } });
    for (const status of ["todo", "doing", "done", undefined, "todo"]) {
      let unsubscribe = () => {};
      const published = new Promise<void>((resolve) => {
        unsubscribe = harness.session.subscribe(() => {
          if (stringValue(resultBlock(harness)!.properties, "builtin.task-status") === status)
            resolve();
        });
      });
      try {
        await harness.settle(async () => {
          fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
          await published;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
      } finally {
        unsubscribe();
      }
      await waitFor(() =>
        expect(stringValue(resultBlock(harness)!.properties, "builtin.task-status")).toBe(status),
      );
      expect(editor).toHaveFocus();
      expect(editor).toHaveValue("Ship it today");
    }
    expect(resultBlock(harness)?.markdown).toBe("Ship it today");
    expect(findPage(harness.session.getState().snapshot, "home")?.blocks).toHaveLength(2);
  });

  it("uses the same block input pipeline in the list renderer", async () => {
    await withResult("");
    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");

    const settled = within(list).getByTitle("Edit Text");
    expect(settled.tagName).toBe("TEXTAREA");
    await user.click(settled);
    const editor = (await screen.findByTestId("query-markdown-editor")) as HTMLTextAreaElement;
    expect(editor).toBe(settled);
    await user.keyboard("[[");

    expect(editor).toHaveValue("[]");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 1]);
  });

  it("runs slash commands against the canonical result block", async () => {
    const harness = await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    const commands: Array<{ type: string; commands?: Array<{ type: string }> }> = [];
    harness.port.beforeExecute = async (command) => {
      commands.push(command);
    };
    await user.type(editor, " /done");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => {
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe(
        "done",
      );
    });
    expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
    expect(commands).toEqual([expect.objectContaining({ type: "set_property" })]);

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    expect(
      stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status"),
    ).toBeUndefined();
  });

  it("keeps result completions attached when the surrounding document scrolls", async () => {
    await withResult("Ship it");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    await user.type(editor, " /");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();

    const documentScroll = document.querySelector<HTMLElement>(".page-scroll");
    expect(documentScroll).not.toBeNull();
    fireEvent.scroll(documentScroll!);
    expect(screen.getByTestId("slash-menu")).toBeInTheDocument();
    expect(editor).toHaveValue("Ship it /");
    expect(editor).toHaveFocus();
  });

  it("uses hash completion to tag the canonical result block", async () => {
    const harness = await withResult("Ship it");
    await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    const commands: Array<{ type: string; commands?: Array<{ type: string }> }> = [];
    harness.port.beforeExecute = async (command) => {
      commands.push(command);
    };
    await user.type(editor, " #pro");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => expect(resultBlock(harness)?.tags).toContain("project"));
    expect(commands).toEqual([expect.objectContaining({ type: "add_tag" })]);

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    expect(resultBlock(harness)?.tags).not.toContain("project");
  });

  it("routes undo and redo through document history while the query editor is focused", async () => {
    const harness = await withResult("Ship");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    await user.type(editor, " it");

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship"));
    await waitFor(() => expect(editor).toHaveValue("Ship"));

    await user.keyboard("{Meta>}{Shift>}z{/Shift}{/Meta}");
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => expect(editor).toHaveValue("Ship it"));
  });

  it("routes contextual property commands to the active query result", async () => {
    const bridge = commandBridge();
    const harness = await withResult(
      "Ship it",
      <CommandContext.Provider value={bridge}>
        <PageView />
      </CommandContext.Provider>,
    );
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByTestId("query-edit-text"));
    await screen.findByTestId("query-markdown-editor");

    let handled = false;
    act(() => {
      handled = bridge.requestProperties("builtin.task-status");
    });
    expect(handled).toBe(true);
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Done" }));

    await waitFor(() => {
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe(
        "done",
      );
    });
    const page = findPage(harness.session.getState().snapshot, "home");
    expect(stringValue(page?.properties ?? [], "builtin.task-status")).toBeUndefined();
  });

  it("draws a moment in a table cell as one object: the day, its time, its tone", async () => {
    const harness = await withResult();
    const query = storedQuery(harness)!;
    const plan = decodePlan(
      activeDefinition(query).plan!.payload,
      activeDefinition(query).plan!.version,
    )!;
    const nextPlan = {
      ...plan,
      columns: [
        ...plan.columns,
        {
          id: "scheduled",
          source: { kind: "property" as const, key: "builtin.task-scheduled" },
        },
      ],
    };
    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [
        { id: "text", source: { kind: "content" } },
        { id: "page", source: { kind: "page" } },
        {
          id: "scheduled",
          source: { kind: "property", key: "builtin.task-scheduled" },
          time_column: "clock",
        },
      ],
      rows: [
        {
          subject: {
            kind: "block",
            owner: { kind: "page", id: "home" },
            id: harness.resultBlockId,
          },
          values: {
            text: [
              {
                kind: "literal",
                value: "Ship the builder",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
            scheduled: [
              {
                kind: "literal",
                value: "2026-08-21",
                datatype: "http://www.w3.org/2001/XMLSchema#date",
              },
            ],
            ["clock"]: [
              {
                kind: "literal",
                value: "21:30",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
          },
        },
      ],
      revision: 6,
      frontier: "fixture-6",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.queryBlockId,
      },
      view_id: "all",
      plan: { version: QUERY_PLAN_VERSION, payload: JSON.stringify(nextPlan) },
    });

    const table = await screen.findByTestId("query-table");
    // The day and the time of day are one fact, drawn as the pill the strip
    // under a block draws. The relative label explains the distance in words.
    const moment = await waitFor(() => within(table).getByTestId("query-edit-scheduled"));
    expect(moment).toHaveTextContent("21:30");
    expect(moment).not.toHaveTextContent(/AM|PM/);
    const pill = moment.querySelector(".query-due")!;
    expect(pill.querySelector(".task-moment-relative")).toHaveTextContent(/days ago/);
    expect(pill).toHaveAttribute("data-due", "overdue");
    expect(pill).toHaveAttribute("data-palette", "danger");
    // The time rode along in the compiler's own namespace, so it is part of the
    // moment and never a column of its own.
    expect(
      within(table)
        .queryAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Text", "Page", "Scheduled"]);
  });

  it("uses only the canonical task field in a block list", async () => {
    const harness = await withResult();
    const query = storedQuery(harness)!;
    const plan = decodePlan(
      activeDefinition(query).plan!.payload,
      activeDefinition(query).plan!.version,
    )!;
    const nextPlan = {
      ...plan,
      columns: [
        ...plan.columns,
        { id: "status", source: { kind: "property" as const, key: "builtin.task-status" } },
      ],
    };
    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [
        { id: "text", source: { kind: "content" } },
        { id: "page", source: { kind: "page" } },
        { id: "status", source: { kind: "property", key: "builtin.task-status" } },
      ],
      rows: [
        {
          subject: {
            kind: "block",
            owner: { kind: "page", id: "home" },
            id: harness.resultBlockId,
          },
          values: {
            text: [
              {
                kind: "literal",
                value: "Ship the builder",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
            page: [
              {
                kind: "iri",
                value: "urn:neoseq:entity:test-graph:page:home",
                entity: { kind: "page", id: "home" },
              },
            ],
          },
        },
      ],
      revision: 5,
      frontier: "fixture-5",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.queryBlockId,
      },
      view_id: "all",
      plan: { version: QUERY_PLAN_VERSION, payload: JSON.stringify(nextPlan) },
    });
    const user = userEvent.setup();
    // The table projects the selected empty cell as an editing affordance.
    const table = await screen.findByTestId("query-table");
    expect(await within(table).findByTestId("query-edit-status")).toHaveAttribute(
      "data-slot",
      "dropdown-menu-trigger",
    );

    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    // The same projected cell creates nothing in a list: canonical absence wins.
    expect(within(list).queryByTestId("prop-builtin.task-status")).not.toBeInTheDocument();
    expect(within(list).queryByTestId("query-edit-block-status")).not.toBeInTheDocument();

    await harness.session.execute({
      type: "set_property",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.resultBlockId,
      },
      key: "builtin.task-status",
      value: { type: "string", value: "todo" },
    });
    await waitFor(() => expect(within(list).getByTitle("Edit Task status")).toBeInTheDocument());
    await user.click(within(list).getByTitle("Edit Task status"));

    // A closed enumeration has one popup wherever it is reached from: the four
    // radio rows the outline's own mark opens, not the generic two-stage key and
    // value picker (designs/interaction.md § Choice).
    const menu = await screen.findByRole("menu");
    expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
    // The four radio rows and the explicit removal row — the outline's menu,
    // not a key/value stage.
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((row) => row.textContent),
    ).toEqual(["To-do", "Doing", "Done", "Cancelled"]);
    expect(within(menu).getByRole("menuitem", { name: "Remove status" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitemradio", { name: "Done" }));

    await waitFor(() => {
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe(
        "done",
      );
    });
  });

  it("pins an active row when its edit makes it leave the result", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    await user.click(
      (await screen.findByTestId("query-table")).querySelector('[data-testid="query-edit-text"]')!,
    );
    await screen.findByTestId("query-markdown-editor");

    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [
        { id: "text", source: { kind: "content" } },
        { id: "page", source: { kind: "page" } },
      ],
      rows: [],
      revision: 6,
      frontier: "fixture-6",
    };
    await harness.session.execute({
      type: "set_property",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.resultBlockId,
      },
      key: "user.pin-check",
      value: { type: "string", value: "changed" },
    });

    await waitFor(() =>
      expect(screen.getByText("No longer matches this query")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("query-row")).toHaveAttribute("data-pinned", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
  });
});
