import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { CorePortFailure } from "../../src/core-worker";
import { findBlock, findPage, queryDocument, stringValue, type PropertyDocument } from "../../src/core-port/snapshot";
import { compilePlan } from "../../src/entities/query-compile";
import { decodePlan } from "../../src/entities/query-plan";
import { resetAppSettingsCache, setEditorKeymap } from "../../src/entities/settings";
import { chooseFromMenu, GRAPH_ID, mountAt } from "./harness";
import type { Harness } from "./harness";
import {
  CommandContext,
  createContextualHandlerRegistry,
  type CommandBridge,
  type PageActions,
} from "../../src/features/commands/context";
import { PageView } from "../../src/features/page/PageView";

async function mountPage(custom?: ReactElement): Promise<Harness> {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`, custom);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await harness.session.execute({
    type: "insert_block",
    owner: { kind: "page", id: "home" },
    parent: null,
    index: 0,
    markdown: "",
  });
  return harness;
}

function storedQuery(harness: Harness): PropertyDocument | undefined {
  const block = harness.session.getState().snapshot.pages[0]?.blocks[0];
  return block && queryDocument(block.properties);
}

function commandBridge(): CommandBridge {
  const blocks = createContextualHandlerRegistry<(key?: string) => void>();
  let pageProperties: ((key?: string) => void) | null = null;
  let pageActions: PageActions | null = null;
  return {
    openPalette: () => {},
    openShortcuts: () => {},
    openSettings: () => {},
    registerBlockProperties: (handler) => blocks.register(handler),
    setPageProperties: (handler) => { pageProperties = handler; },
    setPageActions: (actions) => { pageActions = actions; },
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

/** The one route to a query: `/`, never the property picker. */
async function createQuery(harness: Harness): Promise<void> {
  const user = userEvent.setup();
  const textarea = await screen.findByLabelText("Block text");
  await user.click(textarea);
  await user.type(textarea, "/query");
  const menu = await screen.findByTestId("slash-menu");
  await user.click(within(menu).getByRole("option", { name: /^Query/ }));
  await screen.findByTestId("query-builder");
  await waitFor(() => expect(storedQuery(harness)?.plan).toBeTruthy());
}

describe("the query builder", () => {
  it("is what `/` creates, and it saves a plan beside its compiled SPARQL", async () => {
    const harness = await mountPage();
    await createQuery(harness);

    const document = storedQuery(harness)!;
    const plan = decodePlan(document.plan!.payload, document.plan!.version);
    expect(plan?.subject).toBe("block");
    expect(plan?.columns.map((column) => column.id)).toEqual(["text", "page"]);
    // The source is the executable artifact and it is always the plan's output.
    expect(document.source).toContain("?q_subject a neo:Block .");
    expect(document.source).toContain("LIMIT 100");
    // The block text keeps no trace of the command that built it.
    expect(await screen.findByLabelText("Block text")).toHaveValue("");
  });

  it("turns a condition a person chose into the SPARQL the core runs", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("qb-add-condition"));
    const condition = await screen.findByTestId("qb-condition");
    await chooseFromMenu(user, within(condition).getByTestId("qb-field"), "Status");
    await chooseFromMenu(user, within(condition).getByTestId("qb-value"), "Doing");

    await waitFor(() => {
      expect(storedQuery(harness)?.source).toContain("?q_subject prop:builtin.task-status ?q_p0 .");
    });
    const plan = decodePlan(storedQuery(harness)!.plan!.payload, 1);
    expect(plan?.where.children).toHaveLength(1);
  });

  it("carries a nested alternative into the plan", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("qb-add-group"));
    await waitFor(() => expect(screen.getAllByTestId("qb-group")).toHaveLength(2));
    // A group renders inside its parent's children, so the nested group's own
    // "Condition" button comes first in the document.
    const adders = () => screen.getAllByRole("button", { name: "Condition" });
    await user.click(adders()[0]);
    await user.click(adders()[0]);

    await waitFor(() => {
      const plan = decodePlan(storedQuery(harness)!.plan!.payload, 1);
      const group = plan?.where.children[0];
      expect(group?.kind).toBe("group");
      expect(group?.kind === "group" && group.match).toBe("any");
      expect(group?.kind === "group" && group.children).toHaveLength(2);
    });
    // Alternatives reach the row through EXISTS, never through UNION.
    expect(storedQuery(harness)?.source).toMatch(/EXISTS \{[\s\S]*\|\|[\s\S]*EXISTS \{/);
  });

  it("shows a chosen column and drops it again", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await chooseFromMenu(user, screen.getByTestId("qb-add-column"), "Tags");
    await waitFor(() => {
      const plan = decodePlan(storedQuery(harness)!.plan!.payload, 1);
      const tags = plan?.columns.find((column) => column.source.kind === "tags");
      // A relation with many values folds into one cell by default.
      expect(tags?.aggregate).toBe("list");
    });
    expect(storedQuery(harness)?.source).toContain("GROUP_CONCAT");

    const chips = screen.getAllByTestId("qb-column");
    const tagChip = chips[chips.length - 1];
    await user.click(within(tagChip).getByRole("button", { name: /Remove the .* column/ }));
    await waitFor(() => {
      const plan = decodePlan(storedQuery(harness)!.plan!.payload, 1);
      expect(plan?.columns.some((column) => column.source.kind === "tags")).toBe(false);
    });
  });

  // Hand-written SPARQL is its own door in, not a one-way door out. A built
  // query can always be read as SPARQL and never converted into it, so nothing
  // a person builds can be made unbuildable by one press of a menu row.
  it("has no route that turns a built query into a hand-written one", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-actions-trigger"));
    expect(await screen.findByRole("menuitem", { name: "Show SPARQL" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /SPARQL…/ })).not.toBeInTheDocument();
    // Neither is running one a verb: the block reruns itself.
    expect(screen.queryByRole("menuitem", { name: "Run query" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("menuitem", { name: "Show SPARQL" }));
    expect(await screen.findByTestId("query-compiled")).toHaveTextContent(
      "?q_subject a neo:Block .",
    );
    expect(storedQuery(harness)?.plan).toBeTruthy();
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
  });

  // `/ Advanced query` is that door: a query with no plan, whose editor is the
  // SPARQL and whose caption says so.
  it("creates a hand-written query straight from the slash menu", async () => {
    const harness = await mountPage();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/sparql");
    const menu = await screen.findByTestId("slash-menu");
    await user.click(within(menu).getByRole("option", { name: /^Advanced query/ }));

    const source = await screen.findByLabelText<HTMLTextAreaElement>("SPARQL source");
    expect(source.value).toBe("");
    // The empty editor teaches the shape rather than leaving a blank box.
    expect(source.placeholder).toContain("SELECT ?block ?text WHERE");
    expect(screen.getByTestId("query-summary")).toHaveAccessibleName("SPARQL");
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    await waitFor(() => expect(storedQuery(harness)?.plan).toBeFalsy());
  });

  it("removes the whole query from its own menu", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-actions-trigger"));
    await user.click(await screen.findByRole("menuitem", { name: "Remove query" }));
    await waitFor(() => expect(storedQuery(harness)).toBeUndefined());
    expect(screen.queryByTestId("query-block")).not.toBeInTheDocument();
  });

  // The block is the answer; the question is a disclosure. A query nobody has
  // said anything about yet is the one case where that is backwards, so it opens
  // on its editor — and the caption it collapses to is the plan read back.
  it("reads the plan back as a caption, and the caption puts the editor away", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text"],
      rows: [{
        q_subject: {
          kind: "iri",
          value: "urn:neoseq:entity:test-graph:block:b-2",
          entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
        },
        text: {
          kind: "literal",
          value: "Ship the builder",
          datatype: "http://www.w3.org/2001/XMLSchema#string",
        },
      }],
      revision: 7,
      frontier: "fake-7",
    };

    const summary = screen.getByTestId("query-summary");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(summary).toHaveAccessibleName("Blocks");

    await user.click(screen.getByTestId("qb-add-condition"));
    const condition = await screen.findByTestId("qb-condition");
    await chooseFromMenu(user, within(condition).getByTestId("qb-field"), "Status");
    await chooseFromMenu(user, within(condition).getByTestId("qb-value"), "Doing");

    // Word for word the builder's own vocabulary, and it tracks the plan in hand
    // rather than the one last written to the document.
    await waitFor(() => expect(summary).toHaveAccessibleName("Blocks · Status is Doing"));

    await waitFor(() =>
      expect(screen.getByTestId("query-count")).toHaveTextContent("1 result"));

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    // What the reader kept is what the query found — and how much of it.
    expect(screen.getByTestId("query-count")).toHaveTextContent("1 result");
    expect(screen.getByTestId("query-table")).toBeInTheDocument();
    // The revision moved off the caption, but not out of reach.
    expect(screen.getByTestId("query-block")).toHaveAttribute("data-revision", "7");
  });

  it("leaves an empty result count as status instead of an empty disclosure", async () => {
    const harness = await mountPage();
    await createQuery(harness);

    const count = await screen.findByTestId("query-count");
    await waitFor(() => expect(count).toHaveTextContent("No results"));
    expect(count.tagName).toBe("SPAN");
    expect(count).not.toHaveAttribute("aria-expanded");
  });

  it("never offers the query property through the picker", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/prop");
    await user.keyboard("{Enter}");
    const picker = await screen.findByTestId("property-picker");
    await user.type(within(picker).getByRole("combobox"), "query");
    // Not as a candidate, and not as an existing row either: the query block is
    // the only surface that edits it.
    expect(within(picker).queryByRole("option", { name: /Query/ })).not.toBeInTheDocument();
  });
});

describe("query result views", () => {
  async function withResult(markdown = "Ship the builder", custom?: ReactElement): Promise<Harness> {
    const harness = await mountPage(custom);
    await createQuery(harness);
    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text", "page"],
      rows: [
        {
          q_subject: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:block:b-2",
            entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
          },
          text: {
            kind: "literal",
            value: markdown,
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
          page: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:page:home",
            entity: { kind: "page", id: "home" },
          },
        },
      ],
      revision: 4,
      frontier: "fake-4",
    };
    // The query block is b-1; b-2 is the canonical result edited through the
    // projection. Setting the fake result before this command makes its normal
    // canonical invalidation run the query with the row in place.
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 1,
      markdown,
    });
    return harness;
  }

  function resultBlock(harness: Harness) {
    const page = findPage(harness.session.getState().snapshot, "home");
    return page ? findBlock(page, "b-2") : undefined;
  }

  function dragColumn(handle: HTMLElement, from: number, to: number): void {
    fireEvent.pointerDown(handle, { clientX: from });
    fireEvent.mouseMove(document, { clientX: to });
    // The component commits on the pointer boundary; TanStack's mouse listener
    // then closes its transient resize gesture, matching the browser's event
    // sequence for a mouse-backed pointer.
    fireEvent.pointerUp(window, { clientX: to });
    fireEvent.mouseUp(document, { clientX: to });
  }

  function firstColumnWidth(table: HTMLElement): string {
    const column = within(table).getByRole("table").querySelector("col");
    if (!(column instanceof HTMLTableColElement)) throw new Error("query table has no column");
    return column.style.width;
  }

  it("folds the answer independently and remembers it for the graph session", async () => {
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
    expect(within(table).queryByRole("columnheader", { name: /q_subject/ })).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Text/ })).toBeInTheDocument();
    // Editable text is already the block input surface; opening the block is a
    // separate route. A page cell reads as the page's name, not as its IRI.
    expect(within(table).getByRole("textbox", { name: "Block text" }))
      .toHaveValue("Ship the builder");
    expect(within(table).getByRole("button", { name: "Open “Ship the builder”" }))
      .toBeInTheDocument();
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

  it("reorders columns by dragging a heading, and says where the column will land", async () => {
    const harness = await withResult();
    const table = await screen.findByTestId("query-table");
    const headings = () => within(table)
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
    expect(within(table).getAllByTestId("query-row")[0].children[1])
      .toHaveAttribute("data-seam", "after");
    expect(headings()).toEqual(["Text", "Page"]);

    fireEvent.drop(cells[1], { dataTransfer: transfer });
    await waitFor(() => expect(headings()).toEqual(["Page", "Text"]));
    // A running order the view now owns, with every column's own record intact.
    expect(storedQuery(harness)?.views[0]?.columns.map((column) => column.variable))
      .toEqual(["page", "text"]);
  });

  it("keeps a header sort in the saved view, so the order survives a reload", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const savedSort = () =>
      storedQuery(harness)?.views[0]?.options.sort;

    const table = await screen.findByTestId("query-table");
    // The heading *is* the sort control, so its name is the column's name.
    const heading = () => within(table).getByRole("button", { name: "Text", exact: true });
    await user.click(heading());

    await waitFor(() => expect(savedSort()).toEqual([{ variable: "text", descending: false }]));
    // The header states the order it is in, so the saved fact and the announced
    // one cannot disagree.
    await waitFor(() =>
      expect(within(table).getByRole("columnheader", { name: /Text/ }))
        .toHaveAttribute("aria-sort", "ascending"),
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
    const plan = decodePlan(query.plan!.payload, query.plan!.version)!;
    const nextPlan = {
      ...plan,
      columns: [{
        id: "priority",
        source: { kind: "property" as const, key: "builtin.task-priority" },
      }],
    };
    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "priority"],
      rows: ["high", undefined, "low", "medium"].map((priority) => ({
        q_subject: {
          kind: "iri" as const,
          value: "urn:neoseq:entity:test-graph:block:b-2",
          entity: { kind: "block" as const, owner: { kind: "page", id: "home" }, id: "b-2" },
        },
        ...(priority ? {
          priority: {
            kind: "literal" as const,
            value: priority,
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
        } : {}),
      })),
      revision: 5,
      frontier: "fake-5",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      plan: { version: 1, payload: JSON.stringify(nextPlan) },
      source: compilePlan(nextPlan).source,
    });
    const table = await screen.findByTestId("query-table");
    const user = userEvent.setup();
    const heading = within(table).getByRole("button", {
      name: "Priority",
      exact: true,
    });
    const rowLabels = () => within(table).getAllByTestId("query-row")
      .map((row) => row.textContent);
    await user.click(heading);
    await waitFor(() => {
      expect(rowLabels()).toEqual(["—", "Low", "Medium", "High"]);
    });
    await user.click(heading);
    await waitFor(() => expect(rowLabels()).toEqual(["High", "Medium", "Low", "—"]));
  });

  it("applies the saved presentation order to list rows", async () => {
    const harness = await withResult("Zulu");
    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text", "page"],
      rows: [
        {
          q_subject: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:block:b-2",
            entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
          },
          text: {
            kind: "literal",
            value: "Zulu",
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
          page: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:page:home",
            entity: { kind: "page", id: "home" },
          },
        },
        {
          q_subject: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:block:b-3",
            entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-3" },
          },
          text: {
            kind: "literal",
            value: "Alpha",
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
          page: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:page:home",
            entity: { kind: "page", id: "home" },
          },
        },
      ],
      revision: 6,
      frontier: "fake-6",
    };
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 2,
      markdown: "Alpha",
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("query-count")).toHaveTextContent("2 results"));
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    const values = () => within(list)
      .getAllByRole<HTMLTextAreaElement>("textbox", { name: "Block text" })
      .map((field) => field.value);
    expect(values()).toEqual(["Zulu", "Alpha"]);

    const putListSort = async (descending: boolean) => {
      const view = storedQuery(harness)!.views[0]!;
      await harness.session.execute({
        type: "put_query_view",
        owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
        view: {
          ...view,
          options: { ...view.options, sort: [{ variable: "text", descending }] },
        },
      });
    };

    await putListSort(false);
    await waitFor(() => expect(values()).toEqual(["Alpha", "Zulu"]));

    await putListSort(true);
    await waitFor(() => expect(values()).toEqual(["Zulu", "Alpha"]));
  });

  // An order is a list, so a second heading is a tie-breaker rather than a
  // replacement — and precedence is stated, because an arrow cannot say it.
  it("accumulates an order across headings and lets the panel reorder it", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const savedSort = () =>
      storedQuery(harness)?.views[0]?.options.sort;

    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByRole("button", { name: "Text", exact: true }));
    await user.click(within(table).getByRole("button", { name: "Page", exact: true }));
    await waitFor(() => expect(savedSort()).toEqual([
      { variable: "text", descending: false },
      { variable: "page", descending: false },
    ]));
    // Rank appears exactly when there is a second term for it to precede.
    const heading = (name: RegExp) => within(table).getByRole("columnheader", { name });
    expect(heading(/Text/)).toHaveTextContent("Text1");
    expect(heading(/Page/)).toHaveTextContent("Page2");

    await user.click(screen.getByTestId("query-sort-trigger"));
    const panel = await screen.findByTestId("query-sort-panel");
    await user.click(within(panel).getByRole("button", { name: "Move Page earlier" }));
    await waitFor(() => expect(savedSort()).toEqual([
      { variable: "page", descending: false },
      { variable: "text", descending: false },
    ]));

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
    const savedWidth = () => storedQuery(harness)?.views[0]?.columns
      .find((column) => column.variable === "text")?.width;

    // Until the reader takes the widths over, the table declares none and fills
    // its block; the first drag is what hands the layout to them.
    expect(firstColumnWidth(table)).toBe("");
    dragColumn(handle, 180, 260);
    await waitFor(() => expect(savedWidth()).toBe(260));
    expect(firstColumnWidth(table)).toBe("260px");

    await harness.session.execute({ type: "undo" });
    await waitFor(() => expect(savedWidth()).toBeUndefined());
    await waitFor(() => expect(firstColumnWidth(table)).toBe(""));

    await harness.session.execute({ type: "redo" });
    await waitFor(() => expect(savedWidth()).toBe(260));
    await waitFor(() => expect(firstColumnWidth(table)).toBe("260px"));

    const current = storedQuery(harness)!.views[0]!;
    await harness.session.execute({
      type: "put_query_view",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      view: {
        ...current,
        columns: current.columns.map((column) =>
          column.variable === "text" ? { ...column, width: 224 } : column),
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

    dragColumn(
      within(table).getByRole("separator", { name: "Resize Text" }),
      180,
      260,
    );

    await waitFor(() => expect(firstColumnWidth(table)).toBe(""));
    expect(storedQuery(harness)?.views[0]?.columns)
      .toEqual([]);
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
    expect(within(row).getByRole("button", { name: /Open “Ship the builder”/ })).toBeInTheDocument();
    expect(row).toHaveTextContent("Ship the builder");
  });

  it("renders a block result from its canonical snapshot through the shared block presentation", async () => {
    const harness = await withResult("Stale RDF text");
    const owner = { kind: "block" as const, owner: { kind: "page", id: "home" }, id: "b-2" };
    await harness.session.execute({
      type: "edit_markdown",
      owner: { kind: "page", id: "home" },
      block_id: "b-2",
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

    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const row = within(await screen.findByTestId("query-list")).getByTestId("query-list-row");
    expect(row).toHaveClass("block-row");
    expect(row.querySelector(".block-body")).not.toBeNull();
    expect(row.querySelector(".query-block-content .outline-markdown")).not.toBeNull();
    expect(row).toHaveTextContent("Canonical block text");
    expect(row).not.toHaveTextContent("Stale RDF text");
    expect(row.querySelector('[data-status-glyph="done"]')).not.toBeNull();
    expect(row.querySelector('[data-priority-glyph="high"]')).not.toBeNull();
    expect(within(row).getByTestId("prop-user.owner")).toHaveTextContent("Ada");
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
    await waitFor(() => expect(screen.queryByTestId("query-markdown-editor")).not.toBeInTheDocument());
  });

  it("uses the shared Vim text grammar without exposing outline structure", async () => {
    const harness = await withResult();
    await act(async () => setEditorKeymap("vim"));
    try {
      const user = userEvent.setup();
      const table = await screen.findByTestId("query-table");
      const settled = within(table).getByTestId("query-edit-text");
      await user.click(settled);
      const editor = await screen.findByTestId("query-markdown-editor") as HTMLTextAreaElement;

      expect(editor).not.toHaveAttribute("readonly");
      expect(editor).toHaveAttribute("data-vim-mode", "normal");
      expect(screen.getByTestId("query-vim-mode-indicator")).toHaveTextContent("NORMAL");
      editor.setSelectionRange(0, 0);
      await user.keyboard("o");
      expect(editor).toHaveAttribute("data-vim-mode", "normal");
      expect(editor).toHaveValue("Ship the builder");
      await user.keyboard("A");
      await waitFor(() => expect(editor).toHaveAttribute("data-vim-mode", "insert"));
      await user.keyboard(" now{Escape}");
      await user.keyboard("0dw");
      expect(editor).toHaveValue("the builder now");

      await user.click(screen.getByRole("button", { name: "Collapse 1 result" }));
      await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("the builder now"));
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

  it("uses the canonical block input pipeline inside query results", async () => {
    await withResult("");
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor") as HTMLTextAreaElement;
    await user.keyboard("(");

    expect(editor).toHaveValue("()");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([1, 1]);
  });

  it("uses the same block input pipeline in the list renderer", async () => {
    await withResult("");
    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");

    const settled = within(list).getByTitle("Edit Text");
    expect(settled.tagName).toBe("TEXTAREA");
    await user.click(settled);
    const editor = await screen.findByTestId("query-markdown-editor") as HTMLTextAreaElement;
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
    await user.type(editor, " /done");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => {
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status"))
        .toBe("done");
    });
    expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
  });

  it("uses hash completion to tag the canonical result block", async () => {
    const harness = await withResult("Ship it");
    await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    const user = userEvent.setup();
    const table = await screen.findByTestId("query-table");

    await user.click(within(table).getByTestId("query-edit-text"));
    const editor = await screen.findByTestId("query-markdown-editor");
    await user.type(editor, " #pro");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(resultBlock(harness)?.markdown).toBe("Ship it"));
    await waitFor(() => expect(resultBlock(harness)?.tags).toContain("project"));
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
      <CommandContext.Provider value={bridge}><PageView /></CommandContext.Provider>,
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
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status"))
        .toBe("done");
    });
    const page = findPage(harness.session.getState().snapshot, "home");
    expect(stringValue(page?.properties ?? [], "builtin.task-status")).toBeUndefined();
  });

  it("opens the outline's own status menu from a list result", async () => {
    const harness = await withResult();
    const query = storedQuery(harness)!;
    const plan = decodePlan(query.plan!.payload, query.plan!.version)!;
    const nextPlan = {
      ...plan,
      columns: [
        ...plan.columns,
        { id: "status", source: { kind: "property" as const, key: "builtin.task-status" } },
      ],
    };
    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text", "page", "status"],
      rows: [{
        q_subject: {
          kind: "iri",
          value: "urn:neoseq:entity:test-graph:block:b-2",
          entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
        },
        text: {
          kind: "literal",
          value: "Ship the builder",
          datatype: "http://www.w3.org/2001/XMLSchema#string",
        },
        page: {
          kind: "iri",
          value: "urn:neoseq:entity:test-graph:page:home",
          entity: { kind: "page", id: "home" },
        },
      }],
      revision: 5,
      frontier: "fake-5",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      plan: { version: 1, payload: JSON.stringify(nextPlan) },
      source: compilePlan(nextPlan).source,
    });
    // An explicitly retained empty field and an absent field both use the
    // query's task mark. The retained field must not also leak into BlockChips.
    await harness.session.execute({
      type: "ensure_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
      key: "builtin.task-status",
      value_type: "string",
      cardinality: "single",
    });

    const user = userEvent.setup();
    // Both renderers reach the same control. In the table the cell *is* the
    // trigger, so it says so in the DOM before anything is pressed.
    const table = await screen.findByTestId("query-table");
    expect(within(table).getByTestId("query-edit-status")).toHaveAttribute(
      "data-slot",
      "dropdown-menu-trigger",
    );

    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    expect(within(list).queryByTestId("prop-builtin.task-status")).not.toBeInTheDocument();
    await user.click(within(list).getByTitle("Edit Status"));

    // A closed enumeration has one popup wherever it is reached from: the four
    // radio rows the outline's own mark opens, not the generic two-stage key and
    // value picker (§ Choice).
    const menu = await screen.findByRole("menu");
    expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
    // The four radio rows and the explicit removal row — the outline's menu,
    // not a key/value stage.
    expect(within(menu).getAllByRole("menuitemradio").map((row) => row.textContent))
      .toEqual(["To-do", "Doing", "Done", "Cancelled"]);
    expect(within(menu).getByRole("menuitem", { name: "Remove status" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitemradio", { name: "Done" }));

    await waitFor(() => {
      expect(stringValue(resultBlock(harness)?.properties ?? [], "builtin.task-status")).toBe("done");
    });
  });

  it("pins an active row when its edit makes it leave the result", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    await user.click((await screen.findByTestId("query-table")).querySelector(
      '[data-testid="query-edit-text"]',
    )!);
    await screen.findByTestId("query-markdown-editor");

    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text", "page"],
      rows: [],
      revision: 6,
      frontier: "fake-6",
    };
    await harness.session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
      key: "user.pin-check",
      value: { type: "string", value: "changed" },
    });

    await waitFor(() => expect(screen.getByText("No longer matches this query")).toBeInTheDocument());
    expect(screen.getByTestId("query-row")).toHaveAttribute("data-pinned", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByText("No results")).toBeInTheDocument());
  });
});
