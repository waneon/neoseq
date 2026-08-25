import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useState, type ReactElement } from "react";
import { CorePortFailure } from "../../src/core-worker";
import { findBlock, findPage, queryDocument, stringValue, type PropertyDocument } from "../../src/core-port/snapshot";
import { compilePlan, momentTimeVariable } from "../../src/entities/query-compile";
import { decodePlan, tagPlan } from "../../src/entities/query-plan";
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
import { QueryPanel } from "../../src/features/query/QueryPanel";

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

function activeDefinition(document: PropertyDocument) {
  return document.views.find((view) => view.id === document.default_view_id)?.definition
    ?? document.views[0].definition;
}

function storedDefinition(harness: Harness) {
  const document = storedQuery(harness);
  return document ? activeDefinition(document) : undefined;
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

function SeededQuerySwitcher() {
  const [tagId, setTagId] = useState("tag-a");
  return (
    <>
      <button type="button" onClick={() => setTagId("tag-b")}>Switch tag</button>
      <QueryPanel
        binding={{
          kind: "managed",
          owner: { kind: "tag", tag_id: tagId },
          document: undefined,
          seedPlan: tagPlan(tagId),
        }}
        executionKey={JSON.stringify(["tag", tagId])}
        variant="page"
        label="Tag query"
      />
    </>
  );
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
  await waitFor(() => expect(storedDefinition(harness)?.plan).toBeTruthy());
}

describe("the query builder", () => {
  it("adopts a new seed when the same surface moves to another owner", async () => {
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, <SeededQuerySwitcher />);
    await harness.session.execute({ type: "ensure_tag", tag_id: "tag-a", name: "Alpha" });
    await harness.session.execute({ type: "ensure_tag", tag_id: "tag-b", name: "Beta" });
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-conditions-trigger"));
    await waitFor(() => expect(screen.getByTestId("qb-value")).toHaveTextContent("Alpha"));
    await user.click(screen.getByRole("button", { name: "Switch tag" }));
    await waitFor(() =>
      expect(screen.getByTestId("query-conditions-trigger")).toHaveAttribute(
        "title",
        "Blocks · Tag is #Beta",
      ));
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("query-conditions-trigger"));
    await waitFor(() => expect(screen.getByTestId("qb-value")).toHaveTextContent("Beta"));
  });

  it("is what `/` creates, and it saves a plan beside its compiled SPARQL", async () => {
    const harness = await mountPage();
    await createQuery(harness);

    const document = storedQuery(harness)!;
    const plan = decodePlan(
      document.views[0].definition.plan!.payload,
      document.views[0].definition.plan!.version,
    );
    expect(plan?.subject).toBe("block");
    expect(plan?.columns.map((column) => column.id)).toEqual(["text", "page"]);
    // The source is the executable artifact and it is always the plan's output.
    expect(document.views[0].definition.source).toContain("?q_subject a neo:Block .");
    expect(document.views[0].definition.source).toContain("LIMIT 100");
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
      expect(storedDefinition(harness)?.source).toContain("?q_subject prop:builtin.task-status ?q_p0 .");
    });
    const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
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
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
      const group = plan?.where.children[0];
      expect(group?.kind).toBe("group");
      expect(group?.kind === "group" && group.match).toBe("any");
      expect(group?.kind === "group" && group.children).toHaveLength(2);
    });
    // Alternatives reach the row through EXISTS, never through UNION.
    expect(storedDefinition(harness)?.source).toMatch(/EXISTS \{[\s\S]*\|\|[\s\S]*EXISTS \{/);
  });

  // The sentence asks; it does not lay out. What an answer shows and which way it
  // is ordered are changed while reading it, so they are not rows in the editor
  // a reader has to open to reach.
  it("asks the question and says nothing about how the answer is laid out", async () => {
    const harness = await mountPage();
    await createQuery(harness);

    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
    expect(screen.queryByTestId("qb-add-column")).not.toBeInTheDocument();
    expect(screen.queryByTestId("qb-sort")).not.toBeInTheDocument();
    // The two knobs that really are the query's own are still the query's own.
    expect(screen.getByTestId("qb-limit")).toBeInTheDocument();
  });

  // The question says what to look for; the table says what to show. One switch
  // answers for both, because a reader asking for a column means both at once.
  it("switches a column on and off from the table's own columns panel", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-columns-trigger"));
    const panel = await screen.findByTestId("query-columns-panel");
    await user.click(within(panel).getByTestId("query-column-toggle-tags"));

    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
      const tags = plan?.columns.find((column) => column.source.kind === "tags");
      // A relation with many values folds into one cell by default.
      expect(tags?.aggregate).toBe("list");
    });
    expect(storedDefinition(harness)?.source).toContain("GROUP_CONCAT");

    // Nothing else asks for it, so switching it off takes it out of the query
    // rather than merely out of this table.
    await user.click(within(panel).getByTestId("query-column-toggle-tags"));
    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
      expect(plan?.columns.some((column) => column.source.kind === "tags")).toBe(false);
    });
  });

  it("offers only useful display fields and assigns each its natural value shape", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-columns-trigger"));
    const panel = await screen.findByTestId("query-columns-panel");

    // Value shape follows the source's cardinality; it is no longer another
    // choice beside the field switch.
    expect(within(panel).queryByText("each value")).not.toBeInTheDocument();
    expect(within(panel).queryByText("all")).not.toBeInTheDocument();
    expect(within(panel).queryByText("count of")).not.toBeInTheDocument();

    // Structure and private ordering help queries run, but are not facts a
    // reader needs as result columns. Counting the subject is not a field.
    expect(within(panel).queryByText("Parent")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Position")).not.toBeInTheDocument();
    expect(within(panel).queryByText("builtin.favorite-order")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Blocks")).not.toBeInTheDocument();

    await user.click(within(panel).getByTestId("query-column-toggle-tags"));
    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
      expect(plan?.columns.find((column) => column.source.kind === "tags")?.aggregate)
        .toBe("list");
      expect(plan?.columns.find((column) => column.source.kind === "content")?.aggregate)
        .toBeUndefined();
    });
  });

  // A built query can always be *read* as SPARQL and never converted into it, so
  // nothing a person builds can be made unbuildable by one press of a menu row.
  it("discloses the SPARQL it wrote without offering to replace it", async () => {
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
    expect(storedDefinition(harness)?.plan).toBeTruthy();
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
  });

  it("has no door to hand-written SPARQL", async () => {
    await mountPage();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/query");

    // One item for one object. SPARQL is what the builder compiles, readable
    // from every query's own menu and never something a person is asked to type.
    const menu = await screen.findByTestId("slash-menu");
    expect(within(menu).getByRole("option", { name: /^Query/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: /Advanced/ })).not.toBeInTheDocument();
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
  // on its editor — and the caption beside the count is the plan read back.
  it("reads the plan back as a caption, and its own control puts the editor away", async () => {
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

    const conditions = screen.getByTestId("query-conditions-trigger");
    // The phrase is the name of the control that opens the editor that wrote it,
    // rather than a line printed over every answer forever.
    expect(screen.queryByTestId("query-title")).not.toBeInTheDocument();
    expect(conditions).toHaveAttribute("aria-expanded", "true");
    expect(conditions).toHaveAttribute("title", "Blocks");

    await user.click(screen.getByTestId("qb-add-condition"));
    const condition = await screen.findByTestId("qb-condition");
    await chooseFromMenu(user, within(condition).getByTestId("qb-field"), "Status");
    await chooseFromMenu(user, within(condition).getByTestId("qb-value"), "Doing");

    // Word for word the builder's own vocabulary, and it tracks the plan in hand
    // rather than the one last written to the document.
    await waitFor(() =>
      expect(conditions).toHaveAttribute("title", "Blocks · Status is Doing"));

    await waitFor(() =>
      expect(screen.getByTestId("query-count")).toHaveTextContent("1 result"));

    await user.click(conditions);
    expect(conditions).toHaveAttribute("aria-expanded", "false");
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
    // A caption, not a control with its affordance rubbed out: no chevron, and
    // nothing to press.
    expect(count).toHaveAttribute("data-static");
    // It keeps the chevron's slot all the same, so the header does not shift
    // sideways the moment an answer arrives — which is a fact about the CSS, and
    // `geometry.spec` is where columns are measured.
    expect(screen.getByTestId("query-disclosure").tagName).toBe("SPAN");
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

  it("keeps table display columns out of a canonical block list", async () => {
    const harness = await withResult();
    const user = userEvent.setup();

    await screen.findByTestId("query-table");
    await user.click(screen.getByTestId("query-col-menu-page"));
    await user.click(await screen.findByRole("menuitem", { name: "Hide column" }));
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: /Page/ })).not.toBeInTheDocument());

    // A list draws the canonical block rather than the table's result cells.
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    expect(within(list).queryByText("Page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("query-columns-trigger")).not.toBeInTheDocument();
    expect(storedQuery(harness)?.views[0]?.columns
      .find((column) => column.variable === "page")?.hidden).toBe(true);
  });

  it("changes one view's query without changing a sibling view", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    const firstDefinition = structuredClone(storedQuery(harness)!.views[0].definition);
    await harness.session.execute({
      type: "put_query_view",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
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
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, 1);
      expect(plan?.columns.some((column) => column.source.kind === "page")).toBe(false);
    });
    const sibling = storedQuery(harness)?.views.find((item) => item.id === "second");
    const siblingPlan = decodePlan(sibling!.definition.plan!.payload, 1);
    expect(siblingPlan?.columns.some((column) => column.source.kind === "page")).toBe(true);
    expect(sibling?.definition.source).toBe(firstDefinition.source);
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
    const plan = decodePlan(
      activeDefinition(query).plan!.payload,
      activeDefinition(query).plan!.version,
    )!;
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
      view_id: "all",
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

  it("orders list rows by canonical filter fields outside the table projection", async () => {
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
    await harness.session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
      key: "user.owner",
      value: { type: "string", value: "Zoe" },
    });
    await harness.session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-3" },
      key: "user.owner",
      value: { type: "string", value: "Ada" },
    });

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId("query-count")).toHaveTextContent("2 results"));
    const table = await screen.findByTestId("query-table");
    await user.click(within(table).getByRole("button", { name: "Text", exact: true }));
    await waitFor(() => expect(storedQuery(harness)?.views[0]?.options.sort).toEqual([
      { variable: "text", descending: false },
    ]));
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    const list = await screen.findByTestId("query-list");
    const values = () => within(list)
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

    await waitFor(() => expect(storedQuery(harness)?.views[0]?.options.list_sort).toEqual([
      { field: "property:user.owner", descending: false },
    ]));
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
    const savedWidth = (variable: string) => storedQuery(harness)?.views[0]?.columns
      .find((column) => column.variable === variable)?.width;

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

    layOutHeadings(table, 400);
    dragColumn(
      within(table).getByRole("separator", { name: "Resize Text" }),
      400,
      480,
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
    // A table aggregate removes row identity from the table projection. The
    // block list must still execute its own identity projection and render the
    // canonical block instead of falling back to these table cells.
    const tableDocument = storedQuery(harness)!;
    const tablePlan = decodePlan(
      activeDefinition(tableDocument).plan!.payload,
      activeDefinition(tableDocument).plan!.version,
    )!;
    const aggregatePlan = {
      ...tablePlan,
      columns: [
        ...tablePlan.columns,
        { id: "tags", source: { kind: "tags" as const }, aggregate: "list" as const },
      ],
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      view_id: "all",
      plan: { version: 1, payload: JSON.stringify(aggregatePlan) },
      source: compilePlan(aggregatePlan).source,
    });
    const nestedPlan = storedDefinition(harness)!.plan!;
    await harness.session.execute({
      type: "set_query_plan",
      owner,
      view_id: "all",
      plan: nestedPlan,
      source: storedDefinition(harness)!.source,
    });

    const user = userEvent.setup();
    const hostQuery = screen.getAllByTestId("query-block")[0];
    await chooseFromMenu(user, within(hostQuery).getByTestId("query-view-trigger"), "List");
    await waitFor(() => {
      const executed = harness.port.queryRequests.at(-1)?.query.source ?? "";
      expect(executed).toContain("SELECT ?q_subject WHERE");
      expect(executed).not.toContain("GROUP_CONCAT");
    });
    const row = within(await within(hostQuery).findByTestId("query-list")).getByTestId("query-list-row");
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
      // The caret carries the mode here and nothing else does: a badge under a
      // cell would grow its row and announce a mode beside a value the reader
      // had only meant to correct.
      expect(editor).toHaveAttribute("data-vim-mode", "insert");
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
      kind: "select",
      variables: ["q_subject", "text", "page", "scheduled", momentTimeVariable("scheduled")],
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
        scheduled: {
          kind: "literal",
          value: "2026-08-21",
          datatype: "http://www.w3.org/2001/XMLSchema#date",
        },
        [momentTimeVariable("scheduled")]: {
          kind: "literal",
          value: "21:30",
          datatype: "http://www.w3.org/2001/XMLSchema#string",
        },
      }],
      revision: 6,
      frontier: "fake-6",
    };
    await harness.session.execute({
      type: "set_query_plan",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      view_id: "all",
      plan: { version: 1, payload: JSON.stringify(nextPlan) },
      source: compilePlan(nextPlan).source,
    });

    const table = await screen.findByTestId("query-table");
    // The day and the time of day are one fact, drawn as the pill the strip
    // under a block draws — and a day in the past on an unsettled row says
    // `Overdue` in words rather than in colour alone.
    const moment = await waitFor(() => within(table).getByTestId("query-edit-scheduled"));
    expect(moment).toHaveTextContent("21:30");
    expect(moment).not.toHaveTextContent(/AM|PM/);
    const pill = moment.querySelector(".query-due")!;
    expect(pill).toHaveAttribute("data-due", "overdue");
    expect(pill).toHaveAttribute("data-palette", "danger");
    // The time rode along in the compiler's own namespace, so it is part of the
    // moment and never a column of its own.
    expect(within(table).queryAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Text", "Page", "Scheduled"]);
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
      view_id: "all",
      plan: { version: 1, payload: JSON.stringify(nextPlan) },
      source: compilePlan(nextPlan).source,
    });
    const user = userEvent.setup();
    // The table projects the selected empty cell as an editing affordance.
    const table = await screen.findByTestId("query-table");
    expect(within(table).getByTestId("query-edit-status")).toHaveAttribute(
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
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-2" },
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
