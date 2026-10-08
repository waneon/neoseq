import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CorePortFailure } from "../../src/core-worker";
import { decodePlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";
import { chooseFromMenu, GRAPH_ID } from "./harness";
import {
  createdBlock,
  storedQuery,
  activeDefinition,
  storedDefinition,
  lastBuiltQuery,
  withResult,
  resultBlock,
} from "./query-support";

describe("query result views", () => {
  it("keeps explicit summary grain when switching between table and list", async () => {
    const harness = await withResult();
    harness.port.queryResult = null;
    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("qb-grain"), "Summary");
    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      expect(plan?.grain).toBe("summary");
      expect(plan?.columns).toEqual([
        { id: "count", source: { kind: "subject" }, aggregate: "count" },
      ]);
    });
    expect(screen.getByRole("button", { name: "Remove summary field" })).toBeDisabled();
    const table = await screen.findByTestId("query-table");
    await waitFor(() => {
      expect(within(table).getAllByTestId("query-row")).toHaveLength(1);
      expect(within(table).getByTestId("query-row")).toHaveTextContent("2");
    });
    expect(within(table).queryByTestId("query-edit-count")).not.toBeInTheDocument();

    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    expect(within(list).getAllByTestId("query-list-row")).toHaveLength(1);
    expect(list).toHaveTextContent("2");
    expect(list.querySelector(".query-block-content")).toBeNull();
    expect(lastBuiltQuery(harness)).toMatchObject({
      kind: "built",
      plan: { grain: "summary" },
    });

    await chooseFromMenu(user, screen.getByTestId("qb-grain"), "Entities");
    await waitFor(() =>
      expect(
        within(screen.getByTestId("query-list")).getAllByTestId("query-list-row"),
      ).toHaveLength(2),
    );
    expect(lastBuiltQuery(harness)).toMatchObject({
      kind: "built",
      plan: { grain: "entity" },
    });
  });

  it("saves an active result before changing its question to summary grain", async () => {
    const harness = await withResult("Before");
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
    fireEvent.change(editor, { target: { value: "Saved before summary" } });
    await waitFor(() => expect(saving).toBe(true));
    harness.port.queryResult = null;
    await chooseFromMenu(user, screen.getByTestId("qb-grain"), "Summary");

    expect(screen.getByTestId("qb-grain")).toHaveTextContent("Entities");
    expect(decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION)?.grain).toBe(
      "entity",
    );
    await harness.settle(async () => {
      const saved = new Promise<void>((resolve) => {
        const unsubscribe = harness.session.subscribe(() => {
          const definition = storedDefinition(harness);
          if (
            !definition?.plan ||
            decodePlan(definition.plan.payload, QUERY_PLAN_VERSION)?.grain !== "summary"
          )
            return;
          unsubscribe();
          resolve();
        });
      });
      release();
      await saved;
    });
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Saved before summary"));
    await waitFor(() =>
      expect(decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION)?.grain).toBe(
        "summary",
      ),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId("query-table")).getByTestId("query-row")).toHaveTextContent(
        "2",
      ),
    );
    expect(screen.queryByTestId("query-markdown-editor")).not.toBeInTheDocument();
  });

  it("keeps the executed descriptor and editor when a remote question changes grain", async () => {
    const harness = await withResult("Before");
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "Keep the active draft" } });
    const summary = {
      ...decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION)!,
      grain: "summary" as const,
      columns: [
        {
          id: "text",
          label: "Summary count",
          source: { kind: "subject" as const },
          aggregate: "count" as const,
        },
      ],
    };
    harness.port.queryResult = {
      kind: "built",
      grain: "summary",
      subject: "block",
      columns: summary.columns,
      rows: [
        {
          subject: null,
          values: {
            text: [
              { kind: "literal", value: "2", datatype: "http://www.w3.org/2001/XMLSchema#integer" },
            ],
          },
        },
      ],
      revision: 9,
      frontier: "remote-summary",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: harness.queryBlockId },
      view_id: "all",
      plan: { version: QUERY_PLAN_VERSION, payload: JSON.stringify(summary) },
    });
    await waitFor(() =>
      expect(lastBuiltQuery(harness)).toMatchObject({
        kind: "built",
        plan: { grain: "summary" },
      }),
    );
    await harness.settle();

    expect(screen.getByTestId("query-markdown-editor")).toBe(editor);
    expect(editor).toHaveValue("Keep the active draft");
    expect(screen.queryByText("Summary count")).not.toBeInTheDocument();
    fireEvent.compositionEnd(editor, { data: "Keep the active draft" });
    await user.tab();
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Keep the active draft"));
    await waitFor(() => expect(screen.getByText("Summary count")).toBeInTheDocument());
    expect(screen.queryByTestId("query-markdown-editor")).not.toBeInTheDocument();
  });

  it("keeps the entity question and a rejected result draft available for retry", async () => {
    const harness = await withResult("Before");
    const user = userEvent.setup();
    await user.click(
      within(await screen.findByTestId("query-table")).getByTestId("query-edit-text"),
    );
    const editor = await screen.findByTestId("query-markdown-editor");
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "splice_block_content") return;
      throw new CorePortFailure({
        code: "invalid_request",
        message: "rejected edit",
        retryable: false,
      });
    };
    fireEvent.change(editor, { target: { value: "Keep this correction" } });
    await chooseFromMenu(user, screen.getByTestId("qb-grain"), "Summary");

    const error = await screen.findByRole("alert");
    expect(screen.getByTestId("qb-grain")).toHaveTextContent("Entities");
    expect(editor).toHaveValue("Keep this correction");
    expect(resultBlock(harness)?.markdown).toBe("Before");
    harness.port.beforeExecute = null;
    await user.click(within(error).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Keep this correction"));
    expect(decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION)?.grain).toBe(
      "entity",
    );
  });

  function dragColumn(handle: HTMLElement, from: number, to: number): void {
    fireEvent.pointerDown(handle, { clientX: from });
    fireEvent.pointerMove(window, { clientX: to });
    fireEvent.pointerUp(window, { clientX: to });
  }

  /**
   * What the browser would have laid the headings out at. jsdom reports one size
   * for every element, and a resize that starts from the width on screen has to
   * be told a plausible one — which is also the whole point of the fix: the
   * gesture reads the row rather than trusting a fallback.
   */
  function layOutHeadings(table: HTMLElement, width: number): void {
    for (const cell of within(table).getByRole("table").querySelectorAll("th")) {
      Object.defineProperty(cell, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width, height: 32, top: 0, left: 0, bottom: 32, right: width }),
      });
    }
  }

  function firstColumnWidth(table: HTMLElement): string {
    const column = within(table).getByRole("table").querySelector("col");
    if (!(column instanceof HTMLTableColElement)) throw new Error("query table has no column");
    return column.style.width;
  }

  it("folds the answer independently and remembers that it is folded", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Collapse 1 result" });
    const queryRequests = harness.port.queryRequests.length;

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("query-output")).not.toHaveAttribute("hidden");
    // The builder is a different disclosure and does not move with the answer.
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("query-output")).toHaveAttribute("hidden");
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();

    await act(async () => {
      await harness.router.navigate(`/g/${GRAPH_ID}/custom`);
    });
    await act(async () => {
      await harness.router.navigate(`/g/${GRAPH_ID}/p/home`);
    });

    const returned = await screen.findByRole("button", { name: "Expand 1 result" });
    expect(returned).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("query-output")).toHaveAttribute("hidden");

    await user.click(returned);
    expect(returned).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("query-table")).toBeVisible();
    expect(harness.port.queryRequests).toHaveLength(queryRequests);
  });

  it("names its columns in the product's words, not as SPARQL variables", async () => {
    await withResult();
    const table = await screen.findByTestId("query-table");
    // Row identity is carried, never shown: there is no column of block ids.
    expect(
      within(table).queryByRole("columnheader", { name: /q_subject/ }),
    ).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Text/ })).toBeInTheDocument();
    // Editable text is already the block input surface; opening the block is a
    // separate route. A page cell reads as the page's name, not as its IRI.
    expect(within(table).getByRole("textbox", { name: "Block text" })).toHaveValue(
      "Ship the builder",
    );
    expect(
      within(table).getByRole("button", { name: "Open “Ship the builder”" }),
    ).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Home" })).toBeInTheDocument();
  });

  it("uses compact Markdown in cells and the full block projection in a block list", async () => {
    await withResult("Ship **the builder**");
    const user = userEvent.setup();

    const table = await screen.findByTestId("query-table");
    expect(within(table).getByText("the builder").tagName).toBe("STRONG");
    expect(within(table).getByTestId("block-markdown")).toHaveAttribute("data-variant", "compact");

    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    expect(within(list).getByText("the builder").tagName).toBe("STRONG");
    expect(within(list).getByTestId("block-markdown")).toHaveAttribute("data-variant", "block");
    expect(within(list).getByTestId("block-markdown")).toHaveClass("outline-markdown");
  });

  it("follows Markdown links in a table without opening the text editor", async () => {
    await withResult("Read [source](https://example.com)");
    const table = await screen.findByTestId("query-table");
    const link = within(table).getByRole("link", { name: "source" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.closest("button")).toBeNull();
    await userEvent.setup().click(link);
    expect(within(table).queryByTestId("query-markdown-editor")).not.toBeInTheDocument();
    expect(link).toBeInTheDocument();
  });

  it("follows a settled table result's semantic page reference", async () => {
    const harness = await withResult("See ");
    await harness.session.execute({ type: "ensure_page", page_id: "roadmap", title: "Roadmap" });
    const result = harness.port.queryResult;
    if (result?.kind !== "built") throw new Error("expected a built answer");
    result.rows[0].values.text = [
      {
        kind: "literal",
        value: "See [[Roadmap]]",
        datatype: "http://www.w3.org/2001/XMLSchema#string",
      },
    ];
    await harness.session.execute({
      type: "splice_block_content",
      owner: { kind: "page", id: "home" },
      block_id: harness.resultBlockId,
      index: 4,
      delete: 0,
      insert: [{ type: "page_reference", page_id: "roadmap" }],
    });
    const table = await screen.findByTestId("query-table");
    const link = await within(table).findByRole("link", { name: "[[Roadmap]]" });
    await userEvent.setup().click(link);
    expect(harness.router.state.location.pathname).toBe(`/g/${GRAPH_ID}/p/roadmap`);
  });

  it("briefly highlights a result's destination and repeats the cue on another visit", async () => {
    const harness = await withResult();
    const table = await screen.findByTestId("query-table");
    const open = within(table).getByRole("button", { name: "Open “Ship the builder”" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await harness.settle(() => fireEvent.click(open));
      const row = screen
        .getAllByTestId("outline-row")
        .find((element) => element.dataset.blockId === harness.resultBlockId)!;
      expect(row).toHaveAttribute("data-navigation-highlight", "true");
      const firstCue = row.querySelector(".outline-navigation-highlight");
      expect(firstCue).not.toBeNull();
      await harness.settle(() => fireEvent.click(open));
      expect(row.querySelector(".outline-navigation-highlight")).not.toBe(firstCue);
      await harness.settle(() => vi.advanceTimersByTimeAsync(1100));
      expect(row).not.toHaveAttribute("data-navigation-highlight");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides a column into the saved view, so the choice survives a reload", async () => {
    const harness = await withResult();
    const user = userEvent.setup();

    await screen.findByTestId("query-table");
    await user.click(screen.getByTestId("query-col-menu-page"));
    await user.click(await screen.findByRole("menuitem", { name: "Hide column" }));

    await waitFor(() => {
      const view = storedQuery(harness)?.views[0];
      expect(view?.columns.find((column) => column.variable === "page")?.hidden).toBe(true);
    });
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: /Page/ })).not.toBeInTheDocument(),
    );
  });

  it("keeps table display columns out of a canonical block list", async () => {
    const harness = await withResult();
    const user = userEvent.setup();

    await screen.findByTestId("query-table");
    await user.click(screen.getByTestId("query-col-menu-page"));
    await user.click(await screen.findByRole("menuitem", { name: "Hide column" }));
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: /Page/ })).not.toBeInTheDocument(),
    );

    // A list draws the canonical block rather than the table's result cells.
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    expect(within(list).queryByText("Page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("query-columns-trigger")).not.toBeInTheDocument();
    expect(
      storedQuery(harness)?.views[0]?.columns.find((column) => column.variable === "page")?.hidden,
    ).toBe(true);
  });

  it("changes one view's query without changing a sibling view", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const firstDefinition = structuredClone(storedQuery(harness)!.views[0].definition);
    await harness.session.execute({
      type: "put_query_view",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.queryBlockId,
      },
      view: {
        id: "second",
        name: "Second",
        definition: firstDefinition,
        kind: "table",
        position: 1,
        columns: [],
        options: { compact: false, wrap: false, sort: [] },
      },
    });

    await screen.findByTestId("query-table");
    await user.click(screen.getByTestId("query-columns-trigger"));
    const panel = await screen.findByTestId("query-columns-panel");
    await user.click(within(panel).getByTestId("query-column-toggle-page"));

    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      expect(plan?.columns.some((column) => column.source.kind === "page")).toBe(false);
    });
    const sibling = storedQuery(harness)?.views.find((item) => item.id === "second");
    const siblingPlan = decodePlan(sibling!.definition.plan!.payload, QUERY_PLAN_VERSION);
    expect(siblingPlan?.columns.some((column) => column.source.kind === "page")).toBe(true);
    expect(sibling?.definition.source).toBe(firstDefinition.source);
  });

  it("reorders columns by dragging a heading, and says where the column will land", async () => {
    const harness = await withResult();
    const table = await screen.findByTestId("query-table");
    const headings = () =>
      within(table)
        .getAllByRole("columnheader")
        .map((heading) => heading.textContent?.replace(/Resize.*/, "").trim());
    expect(headings()).toEqual(["Text", "Page"]);

    const transfer = { setData: () => {}, getData: () => "", dropEffect: "", effectAllowed: "" };
    const cells = within(table).getAllByRole("columnheader");
    fireEvent.dragStart(cells[0], { dataTransfer: transfer });
    fireEvent.dragOver(cells[1], { dataTransfer: transfer });
    // The seam runs the height of the column it will land beside, and nothing
    // moves until it is dropped.
    expect(cells[1]).toHaveAttribute("data-seam", "after");
    expect(within(table).getAllByTestId("query-row")[0].children[1]).toHaveAttribute(
      "data-seam",
      "after",
    );
    expect(headings()).toEqual(["Text", "Page"]);

    fireEvent.drop(cells[1], { dataTransfer: transfer });
    await waitFor(() => expect(headings()).toEqual(["Page", "Text"]));
    // A running order the view now owns, with every column's own record intact.
    expect(storedQuery(harness)?.views[0]?.columns.map((column) => column.variable)).toEqual([
      "page",
      "text",
    ]);
  });

  it("keeps a header sort in the saved view, so the order survives a reload", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const savedSort = () => storedQuery(harness)?.views[0]?.options.sort ?? [];

    const table = await screen.findByTestId("query-table");
    // The heading *is* the sort control, so its name is the column's name.
    const heading = () => within(table).getByRole("button", { name: "Text", exact: true });
    await user.click(heading());

    await waitFor(() => expect(savedSort()).toEqual([{ variable: "text", descending: false }]));
    // The header states the order it is in, so the saved fact and the announced
    // one cannot disagree.
    await waitFor(() =>
      expect(within(table).getByRole("columnheader", { name: /Text/ })).toHaveAttribute(
        "aria-sort",
        "ascending",
      ),
    );

    // A press cycles the column it is on: ascending, descending, then out.
    await user.click(heading());
    await waitFor(() => expect(savedSort()).toEqual([{ variable: "text", descending: true }]));
    await user.click(heading());
    await waitFor(() => expect(savedSort()).toEqual([]));
  });

  it("sorts missing priority below Low and stored values by registry rank", async () => {
    const harness = await withResult();
    const query = storedQuery(harness)!;
    const plan = decodePlan(
      activeDefinition(query).plan!.payload,
      activeDefinition(query).plan!.version,
    )!;
    const nextPlan = {
      ...plan,
      columns: [
        {
          id: "priority",
          source: { kind: "property" as const, key: "builtin.task-priority" },
        },
      ],
    };
    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [{ id: "priority", source: { kind: "property", key: "builtin.task-priority" } }],
      rows: ["high", undefined, "low", "medium"].map((priority) => ({
        subject: {
          kind: "block" as const,
          owner: { kind: "page", id: "home" },
          id: harness.resultBlockId,
        },
        values: Object.fromEntries(
          Object.entries({
            ...(priority
              ? {
                  priority: {
                    kind: "literal" as const,
                    value: priority,
                    datatype: "http://www.w3.org/2001/XMLSchema#string",
                  },
                }
              : {}),
          }).map(([key, value]) => [key, [value]]),
        ),
      })),
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
    const table = await screen.findByTestId("query-table");
    const user = userEvent.setup();
    const heading = await within(table).findByRole("button", {
      name: "Priority",
      exact: true,
    });
    const rowLabels = () =>
      within(table)
        .getAllByTestId("query-row")
        .map((row) => row.textContent);
    await user.click(heading);
    await waitFor(() => {
      expect(rowLabels()).toEqual(["—", "Low", "Medium", "High"]);
    });
    await user.click(heading);
    await waitFor(() => expect(rowLabels()).toEqual(["High", "Medium", "Low", "—"]));
  });

  it("orders list rows by canonical filter fields outside the table projection", async () => {
    const harness = await withResult("Zulu");
    const inserted = await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 2,
      markdown: "Alpha",
    });
    const alphaBlockId = createdBlock(inserted);
    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [
        { id: "text", source: { kind: "content" } },
        { id: "page", source: { kind: "page" } },
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
                value: "Zulu",
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
        {
          subject: {
            kind: "block",
            owner: { kind: "page", id: "home" },
            id: alphaBlockId,
          },
          values: {
            text: [
              {
                kind: "literal",
                value: "Alpha",
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
      key: "user.owner",
      value: { type: "string", value: "Zoe" },
    });
    await harness.session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: alphaBlockId },
      key: "user.owner",
      value: { type: "string", value: "Ada" },
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("query-count")).toHaveTextContent("2 results"));
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByRole("button", { name: "Text", exact: true }));
    await waitFor(() =>
      expect(storedQuery(harness)?.views[0]?.options.sort).toEqual([
        { variable: "text", descending: false },
      ]),
    );
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    const values = () =>
      within(list)
        .getAllByRole<HTMLTextAreaElement>("textbox", { name: "Block text" })
        .map((field) => field.value);
    expect(values()).toEqual(["Zulu", "Alpha"]);

    await user.click(screen.getByTestId("query-sort-trigger"));
    const panel = await screen.findByTestId("query-sort-panel");
    fireEvent.pointerDown(within(panel).getByTestId("query-sort-add"), { button: 0 });
    // The list sorter consumes the filter catalog, not the projected Text/Page
    // columns. Feature-only documents such as Query never enter either catalog.
    expect(await screen.findByRole("option", { name: "Tag" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Anywhere under" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Position" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Query" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "owner" }));

    await waitFor(() =>
      expect(storedQuery(harness)?.views[0]?.options.list_sort).toEqual([
        { field: "property:user.owner", descending: false },
      ]),
    );
    expect(storedQuery(harness)?.views[0]?.options.sort).toEqual([
      { variable: "text", descending: false },
    ]);
    await waitFor(() => expect(values()).toEqual(["Alpha", "Zulu"]));

    await chooseFromMenu(
      user,
      within(panel).getByRole("combobox", { name: "owner direction" }),
      "Descending",
    );
    await waitFor(() => expect(values()).toEqual(["Zulu", "Alpha"]));
  });

  // An order is a list, so a second heading is a tie-breaker rather than a
  // replacement — and precedence is stated, because an arrow cannot say it.
  it("accumulates an order across headings and lets the panel reorder it", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const savedSort = () => storedQuery(harness)?.views[0]?.options.sort ?? [];

    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByRole("button", { name: "Text", exact: true }));
    await user.click(within(table).getByRole("button", { name: "Page", exact: true }));
    await waitFor(() =>
      expect(savedSort()).toEqual([
        { variable: "text", descending: false },
        { variable: "page", descending: false },
      ]),
    );
    // Rank appears exactly when there is a second term for it to precede.
    const heading = (name: RegExp) => within(table).getByRole("columnheader", { name });
    expect(heading(/Text/)).toHaveTextContent("Text1");
    expect(heading(/Page/)).toHaveTextContent("Page2");

    await user.click(screen.getByTestId("query-sort-trigger"));
    const panel = await screen.findByTestId("query-sort-panel");
    await user.click(within(panel).getByRole("button", { name: "Move Page earlier" }));
    await waitFor(() =>
      expect(savedSort()).toEqual([
        { variable: "page", descending: false },
        { variable: "text", descending: false },
      ]),
    );

    await user.click(within(panel).getByRole("button", { name: "Stop sorting by Text" }));
    await waitFor(() => expect(savedSort()).toEqual([{ variable: "page", descending: false }]));
    await user.click(within(panel).getByRole("button", { name: "Clear sort" }));
    await waitFor(() => expect(savedSort()).toEqual([]));
  });

  it("declares its real column count, so the width-absorbing filler is not a column", async () => {
    await withResult();
    const wrap = await screen.findByTestId("query-table");
    const table = within(wrap).getByRole("table");
    expect(table).toHaveAttribute("aria-colcount", "2");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
  });

  it("reconciles a resized column from the saved view on undo, redo, and later changes", async () => {
    const harness = await withResult();
    const table = await screen.findByTestId("query-table");
    const handle = within(table).getByRole("separator", { name: "Resize Text" });
    const savedWidth = (variable: string) =>
      storedQuery(harness)?.views[0]?.columns.find((column) => column.variable === variable)?.width;

    // Until the reader takes the widths over, the table declares none and fills
    // its block; the first drag is what hands the layout to them. It starts from
    // the width the column is drawn at — 400 of an 800px block shared two ways —
    // and not from the fallback a column with no width of its own falls back to,
    // which is what used to make the first pixel of travel a collapse.
    expect(firstColumnWidth(table)).toBe("");
    layOutHeadings(table, 400);
    dragColumn(handle, 400, 480);
    await waitFor(() => expect(savedWidth("text")).toBe(480));
    expect(firstColumnWidth(table)).toBe("480px");
    // Taking one column over takes the table over, at the widths it was already
    // drawn at: a column left without one would be redrawn at that same fallback
    // the moment its neighbour moved.
    expect(savedWidth("page")).toBe(400);

    await harness.session.execute({ type: "undo" });
    await waitFor(() => expect(savedWidth("text")).toBeUndefined());
    await waitFor(() => expect(firstColumnWidth(table)).toBe(""));

    await harness.session.execute({ type: "redo" });
    await waitFor(() => expect(savedWidth("text")).toBe(480));
    await waitFor(() => expect(firstColumnWidth(table)).toBe("480px"));

    const current = storedQuery(harness)!.views[0]!;
    await harness.session.execute({
      type: "put_query_view",
      owner: {
        kind: "block",
        owner: { kind: "page", id: "home" },
        id: harness.queryBlockId,
      },
      view: {
        ...current,
        columns: current.columns.map((column) =>
          column.variable === "text" ? { ...column, width: 224 } : column,
        ),
      },
    });
    await waitFor(() => expect(firstColumnWidth(table)).toBe("224px"));
  });

  it("drops a transient resize when the view command is rejected", async () => {
    const harness = await withResult();
    const table = await screen.findByTestId("query-table");
    harness.port.beforeExecute = async (command) => {
      if (command.type === "put_query_view") {
        throw new CorePortFailure({
          code: "invalid_request",
          message: "rejected resize",
          retryable: false,
        });
      }
    };

    layOutHeadings(table, 400);
    dragColumn(within(table).getByRole("separator", { name: "Resize Text" }), 400, 480);

    await waitFor(() => expect(firstColumnWidth(table)).toBe(""));
    expect(storedQuery(harness)?.views[0]?.columns).toEqual([]);
  });

  it("renders the list view as outline rows", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");

    await waitFor(() => expect(storedQuery(harness)?.views[0].kind).toBe("list"));
    const list = await screen.findByTestId("query-list");
    const row = within(list).getByTestId("query-list-row");
    // The outline's own grammar: a treeitem with a bullet that opens the block.
    expect(row).toHaveAttribute("role", "treeitem");
    expect(
      within(row).getByRole("button", { name: /Open “Ship the builder”/ }),
    ).toBeInTheDocument();
    expect(row).toHaveTextContent("Ship the builder");
  });
});
