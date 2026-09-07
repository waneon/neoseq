import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState, type ReactElement } from "react";
import { CorePortFailure } from "../../src/core-worker";
import {
  findBlock,
  findPage,
  queryDocument,
  stringValue,
  type PropertyDocument,
} from "../../src/core-port/snapshot";
import { DERIVED_SOURCE_PROVENANCE } from "../../src/entities/query-compile";
import { decodePlan, tagPlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";
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
import { useSessionSelector } from "../../src/features/shell/session-context";

interface PageHarness extends Harness {
  queryBlockId: string;
}

interface ResultHarness extends PageHarness {
  resultBlockId: string;
}

function createdBlock(result: { created_block: string | null }): string {
  if (!result.created_block) throw new Error("insert_block returned no block id");
  return result.created_block;
}

async function mountPage(custom?: ReactElement): Promise<PageHarness> {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`, custom);
  // Most builder tests describe the question, not a live graph answer. Make
  // that fixture boundary explicit now that the test port otherwise runs the
  // real query engine.
  harness.port.queryResult = {
    kind: "built",
    grain: "entity",
    subject: "block",
    columns: [],
    rows: [],
    revision: 0,
    frontier: "query-builder-empty",
  };
  const inserted = await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    return harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "",
    });
  });
  return { ...harness, queryBlockId: createdBlock(inserted) };
}

function storedQuery(harness: Harness): PropertyDocument | undefined {
  const block = harness.session.getState().snapshot.pages[0]?.blocks[0];
  return block && queryDocument(block.properties);
}

function activeDefinition(document: PropertyDocument) {
  return (
    document.views.find((view) => view.id === document.default_view_id)?.definition ??
    document.views[0].definition
  );
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

function SeededQuerySwitcher() {
  const [tagId, setTagId] = useState("tag-a");
  const document = useSessionSelector((state) => {
    const tag = state.snapshot.tags.find((item) => item.id === tagId);
    return tag && queryDocument(tag.properties);
  });
  return (
    <>
      <button type="button" onClick={() => setTagId("tag-b")}>
        Switch tag
      </button>
      <QueryPanel
        binding={{
          kind: "managed",
          owner: { kind: "tag", tag_id: tagId },
          document,
          seedPlan: tagPlan(tagId),
        }}
        executionKey={JSON.stringify(["tag", tagId])}
        variant="page"
        label="Tag query"
      />
    </>
  );
}

/** Creates a query through the slash menu. */
async function createQuery(harness: Harness): Promise<void> {
  const user = userEvent.setup();
  const textarea = await screen.findByLabelText("Block text");
  await user.click(textarea);
  await user.type(textarea, "/query");
  const menu = await screen.findByTestId("slash-menu");
  await harness.settle(() => fireEvent.click(within(menu).getByRole("option", { name: /^Query/ })));
  await screen.findByTestId("query-builder");
  await waitFor(() => expect(storedDefinition(harness)?.plan).toBeTruthy());
  // Slash completion restores the source caret after canonical publication.
  await harness.settle(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

describe("the query builder", () => {
  it("stores explicit conditions disclosure even when the query has no conditions", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const toggleConditions = async (open: boolean) => {
      let unsubscribe = () => {};
      const published = new Promise<void>((resolve) => {
        unsubscribe = harness.session.subscribe(() => {
          if (storedQuery(harness)?.views[0].options.conditions_open === open) resolve();
        });
      });
      try {
        await harness.settle(async () => {
          fireEvent.click(screen.getByTestId("query-conditions-trigger"));
          await published;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        });
      } finally {
        unsubscribe();
      }
    };
    const initialDefinition = storedDefinition(harness);
    await toggleConditions(false);
    await waitFor(() => expect(storedQuery(harness)?.views[0].options.conditions_open).toBe(false));
    await waitFor(() =>
      expect(screen.getByTestId("query-conditions-trigger")).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(storedDefinition(harness)).toEqual(initialDefinition);
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    localStorage.clear();
    await harness.settle(() => harness.router.navigate(`/g/${GRAPH_ID}/custom`));
    await harness.settle(() => harness.router.navigate(`/g/${GRAPH_ID}/p/home`));
    const toggle = await screen.findByTestId("query-conditions-trigger");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggleConditions(true);
    await waitFor(() => expect(storedQuery(harness)?.views[0].options.conditions_open).toBe(true));
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByTestId("query-builder")).toBeInTheDocument();
  });

  it("keeps conditions open after a rejected disclosure write and permits retry", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    harness.port.beforeExecute = async (command) => {
      if (command.type === "put_query_view")
        throw new CorePortFailure({
          code: "invalid_request",
          message: "rejected disclosure",
          retryable: false,
        });
    };
    const toggle = screen.getByTestId("query-conditions-trigger");
    await harness.settle(() => fireEvent.click(toggle));
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled", "true"));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(storedQuery(harness)?.views[0].options.conditions_open).toBeUndefined();
    harness.port.beforeExecute = null;
    await harness.settle(() => fireEvent.click(toggle));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    expect(storedQuery(harness)?.views[0].options.conditions_open).toBe(false);
  });

  it.each([
    { name: "future plan", version: QUERY_PLAN_VERSION + 1, source: "SELECT * WHERE {}" },
    { name: "v1 plan with no source", version: 1, source: "" },
    { name: "v1 plan with source", version: 1, source: "SELECT * WHERE {}" },
  ])("keeps an unsupported $name unavailable and read-only", async ({ version, source }) => {
    const payload = JSON.stringify({
      version,
      subject: "block",
      where: { id: "all", kind: "group", match: "all", children: [] },
      columns: [{ id: "tags", source: { kind: "tags" }, aggregate: "list" }],
      distinct: false,
      limit: 100,
    });
    const document: PropertyDocument = {
      schema: "neoseq.query",
      version: 2,
      default_view_id: "all",
      views: [
        {
          id: "all",
          name: "All",
          definition: {
            language: "sparql-1.1/neoseq-v1",
            source,
            plan: { version, payload },
          },
          kind: "table",
          position: 0,
          columns: [],
          options: { compact: false, wrap: false, sort: [], list_sort: [] },
        },
      ],
    };
    const harness = await mountAt(
      `/g/${GRAPH_ID}/custom`,
      <QueryPanel
        binding={{
          kind: "managed",
          owner: { kind: "page", id: "home" },
          document,
        }}
        executionKey="unsupported-plan"
        variant="page"
        label="Unsupported query"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("newer or incompatible version");
    expect(harness.port.queryRequests).toHaveLength(0);
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("query-conditions-trigger")).not.toBeInTheDocument();
    expect(document.views[0].definition).toEqual({
      language: "sparql-1.1/neoseq-v1",
      source,
      plan: { version, payload },
    });
  });

  it("adopts a new seed when the same surface moves to another owner", async () => {
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, <SeededQuerySwitcher />);
    await harness.session.execute({ type: "ensure_tag", tag_id: "tag-a", name: "Alpha" });
    await harness.session.execute({ type: "ensure_tag", tag_id: "tag-b", name: "Beta" });
    const user = userEvent.setup();

    await harness.settle(() => fireEvent.click(screen.getByTestId("query-conditions-trigger")));
    await waitFor(() => expect(screen.getByTestId("qb-value")).toHaveTextContent("Alpha"));
    await user.click(screen.getByRole("button", { name: "Switch tag" }));
    await waitFor(() =>
      expect(screen.getByTestId("query-conditions-trigger")).toHaveAttribute(
        "title",
        "Blocks · Tag is #Beta",
      ),
    );
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    await harness.settle(() => fireEvent.click(screen.getByTestId("query-conditions-trigger")));
    await waitFor(() => expect(screen.getByTestId("qb-value")).toHaveTextContent("Beta"));
  });

  it("is what `/` creates, and lets the core derive its compatibility SPARQL", async () => {
    const harness = await mountPage();
    await createQuery(harness);

    const document = storedQuery(harness)!;
    const plan = decodePlan(
      document.views[0].definition.plan!.payload,
      document.views[0].definition.plan!.version,
    );
    expect(plan?.subject).toBe("block");
    expect(plan?.columns.map((column) => column.id)).toEqual(["text", "page"]);
    expect(document.views[0].definition.source.startsWith(DERIVED_SOURCE_PROVENANCE)).toBe(true);
    // The block text keeps no trace of the command that built it.
    expect(await screen.findByLabelText("Block text")).toHaveValue("");
  });

  it("persists a condition as a typed plan and a derived explanation", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    await harness.settle(() => fireEvent.click(screen.getByTestId("qb-add-condition")));
    const condition = await screen.findByTestId("qb-condition");
    const choose = async (testId: string, name: string) => {
      // Menu opening owns its asynchronous placement and focus before selection.
      await harness.settle(() =>
        fireEvent.pointerDown(within(condition).getByTestId(testId), {
          button: 0,
          pointerType: "mouse",
        }),
      );
      const option = await screen.findByRole("option", { name, exact: true });
      await harness.settle(() => fireEvent.click(option));
    };
    await choose("qb-field", "Status");
    await choose("qb-value", "Doing");

    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      expect(plan?.where.children).toEqual([
        expect.objectContaining({
          kind: "condition",
          field: { kind: "property", key: "builtin.task-status" },
          value: { type: "text", value: "doing" },
        }),
      ]);
    });
    expect(storedDefinition(harness)?.source.startsWith(DERIVED_SOURCE_PROVENANCE)).toBe(true);
  });

  it("carries a nested alternative into the plan", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("qb-add-group"));
    await waitFor(() => expect(screen.getAllByTestId("qb-group")).toHaveLength(2));
    // A group renders inside its parent's children, so the nested group's own
    // "Condition" button comes first in the document.
    const adders = () => screen.getAllByRole("button", { name: "Add condition" });
    await user.click(adders()[0]);
    await user.click(adders()[0]);

    await waitFor(() => {
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      const group = plan?.where.children[0];
      expect(group?.kind).toBe("group");
      expect(group?.kind === "group" && group.match).toBe("any");
      expect(group?.kind === "group" && group.children).toHaveLength(2);
    });
    expect(storedDefinition(harness)?.source.startsWith(DERIVED_SOURCE_PROVENANCE)).toBe(true);
  });

  it("keeps newer conditions when an earlier plan save finishes", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    harness.port.beforeExecute = async (command) => {
      if (command.type !== "set_query_plan" || saving) return;
      saving = true;
      await pending;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByTestId("qb-add-group"));
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(saving).toBe(true);

      const adders = () => screen.getAllByRole("button", { name: "Add condition" });
      fireEvent.click(adders()[0]);
      fireEvent.click(adders()[0]);
      expect(screen.getAllByTestId("qb-condition")).toHaveLength(2);

      await act(async () => {
        const published = new Promise<void>((resolve) => {
          const unsubscribe = harness.session.subscribe(() => {
            const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
            if (plan?.where.children[0]?.kind !== "group") return;
            unsubscribe();
            resolve();
          });
        });
        release();
        await published;
      });
      expect(screen.getAllByTestId("qb-condition")).toHaveLength(2);

      await act(async () => {
        const published = new Promise<void>((resolve) => {
          const unsubscribe = harness.session.subscribe(() => {
            const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
            const group = plan?.where.children[0];
            if (group?.kind !== "group" || group.children.length !== 2) return;
            unsubscribe();
            resolve();
          });
        });
        await vi.advanceTimersByTimeAsync(600);
        await published;
      });
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      const group = plan?.where.children[0];
      expect(group?.kind === "group" && group.children).toHaveLength(2);
    } finally {
      release();
      harness.port.beforeExecute = null;
      vi.useRealTimers();
    }
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
    await harness.settle(() => fireEvent.click(screen.getByTestId("query-columns-trigger")));
    const panel = screen.getByTestId("query-columns-panel");
    const toggle = within(panel).getByTestId("query-column-toggle-tags");

    // The switch renders from a draft, then a debounce publishes its plan and
    // query answer. Own that timer inside the same React completion boundary;
    // polling only the stored plan can leave the answer publication in flight.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await harness.settle(() => fireEvent.click(toggle));
      expect(toggle).toBeChecked();
      await harness.settle(() => vi.advanceTimersByTimeAsync(600));
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      const tags = plan?.columns.find((column) => column.source.kind === "tags");
      // A repeated field is a value vector, without changing entity grain.
      expect(tags).toBeDefined();
      expect(tags?.aggregate).toBeUndefined();
      expect(storedDefinition(harness)?.source.startsWith(DERIVED_SOURCE_PROVENANCE)).toBe(true);

      // Nothing else asks for it, so switching it off takes it out of the query
      // rather than merely out of this table.
      await harness.settle(() => fireEvent.click(toggle));
      expect(toggle).not.toBeChecked();
      await harness.settle(() => vi.advanceTimersByTimeAsync(600));
      const withoutTags = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      expect(withoutTags?.columns.some((column) => column.source.kind === "tags")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
      const plan = decodePlan(storedDefinition(harness)!.plan!.payload, QUERY_PLAN_VERSION);
      expect(plan?.columns.some((column) => column.source.kind === "tags")).toBe(true);
      expect(
        plan?.columns.find((column) => column.source.kind === "tags")?.aggregate,
      ).toBeUndefined();
      expect(
        plan?.columns.find((column) => column.source.kind === "content")?.aggregate,
      ).toBeUndefined();
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
      DERIVED_SOURCE_PROVENANCE,
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

    const inserted = await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 1,
      markdown: "",
    });
    const resultBlockId = createdBlock(inserted);

    harness.port.queryResult = {
      kind: "built",
      grain: "entity",
      subject: "block",
      columns: [{ id: "text", source: { kind: "content" } }],
      rows: [
        {
          subject: {
            kind: "block",
            owner: { kind: "page", id: "home" },
            id: resultBlockId,
          },
          values: {
            text: [
              {
                kind: "literal",
                value: "Ship the builder",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
          },
        },
      ],
      revision: 7,
      frontier: "fixture-7",
    };
    await harness.session.execute({
      type: "edit_markdown",
      owner: { kind: "page", id: "home" },
      block_id: resultBlockId,
      markdown: "Ship the builder",
    });

    const conditions = screen.getByTestId("query-conditions-trigger");
    // The control describes the authored question while the header uses its subject.
    expect(screen.queryByTestId("query-title")).not.toBeInTheDocument();
    expect(conditions).toHaveAttribute("aria-expanded", "true");
    expect(conditions).toHaveAttribute("title", "Blocks");

    await user.click(screen.getByTestId("qb-add-condition"));
    const condition = await screen.findByTestId("qb-condition");
    await chooseFromMenu(user, within(condition).getByTestId("qb-field"), "Status");
    await chooseFromMenu(user, within(condition).getByTestId("qb-value"), "Doing");

    // Word for word the builder's own vocabulary, and it tracks the plan in hand
    // rather than the one last written to the document.
    await waitFor(() => expect(conditions).toHaveAttribute("title", "Blocks · Status is Doing"));

    await waitFor(() => expect(screen.getByTestId("query-count")).toHaveTextContent("1 result"));

    await harness.settle(() => fireEvent.click(conditions));
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
    // The static count keeps the chevron's presentation slot without exposing
    // a control that has no action.
    expect(screen.getByTestId("query-disclosure").tagName).toBe("SPAN");
  });

  it("keeps an existing query in its builder instead of offering duplicate creation", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/prop");
    await user.keyboard("{Enter}");
    const picker = await screen.findByTestId("property-picker");
    await user.type(within(picker).getByRole("searchbox"), "query");
    // Creating another query must not reset an existing query document.
    expect(within(picker).queryByRole("option", { name: /Query/ })).not.toBeInTheDocument();
  });
});

describe("query result views", () => {
  async function withResult(
    markdown = "Ship the builder",
    custom?: ReactElement,
  ): Promise<ResultHarness> {
    const harness = await mountPage(custom);
    await createQuery(harness);
    // The core chooses block identities. Insert first to learn that identity,
    // then make the final edit after installing the query answer so ordinary
    // canonical invalidation observes the injected row.
    const inserted = await harness.settle(() =>
      harness.session.execute({
        type: "insert_block",
        owner: { kind: "page", id: "home" },
        parent: null,
        index: 1,
        markdown: "Preparing result",
      }),
    );
    const resultBlockId = createdBlock(inserted);
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
            id: resultBlockId,
          },
          values: {
            text: [
              {
                kind: "literal",
                value: markdown,
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
      revision: 4,
      frontier: "fixture-4",
    };
    await harness.settle(() =>
      harness.session.execute({
        type: "edit_markdown",
        owner: { kind: "page", id: "home" },
        block_id: resultBlockId,
        markdown,
      }),
    );
    return { ...harness, resultBlockId };
  }

  function resultBlock(harness: ResultHarness) {
    const page = findPage(harness.session.getState().snapshot, "home");
    return page ? findBlock(page, harness.resultBlockId) : undefined;
  }

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
    expect(harness.port.queryRequests.at(-1)?.query).toMatchObject({
      kind: "built",
      plan: { grain: "summary" },
    });

    await chooseFromMenu(user, screen.getByTestId("qb-grain"), "Entities");
    await waitFor(() =>
      expect(
        within(screen.getByTestId("query-list")).getAllByTestId("query-list-row"),
      ).toHaveLength(2),
    );
    expect(harness.port.queryRequests.at(-1)?.query).toMatchObject({
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
      expect(harness.port.queryRequests.at(-1)?.query).toMatchObject({
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

  async function addSecondResult(harness: ResultHarness) {
    const inserted = await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 2,
      markdown: "Preparing second result",
    });
    const id = createdBlock(inserted);
    const result = harness.port.queryResult;
    if (result?.kind !== "built") throw new Error("expected built fixture");
    harness.port.queryResult = {
      ...result,
      rows: [
        ...result.rows,
        {
          subject: { kind: "block", owner: { kind: "page", id: "home" }, id },
          values: {
            ...result.rows[0].values,
            text: [
              {
                kind: "literal",
                value: "Second result",
                datatype: "http://www.w3.org/2001/XMLSchema#string",
              },
            ],
          },
        },
      ],
      revision: result.revision + 1,
      frontier: "fixture-second-result",
    };
    await harness.session.execute({
      type: "edit_markdown",
      owner: { kind: "page", id: "home" },
      block_id: id,
      markdown: "Second result",
    });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("query-table")).getAllByTestId("query-edit-text"),
      ).toHaveLength(2),
    );
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
    const heading = within(table).getByRole("button", {
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
      const executed = harness.port.queryRequests.at(-1)?.query;
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
