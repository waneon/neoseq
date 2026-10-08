import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CorePortFailure } from "../../src/core-worker";
import { queryDocument, type PropertyDocument } from "../../src/core-port/snapshot";
import { DERIVED_SOURCE_PROVENANCE } from "../../src/entities/query-compile";
import { decodePlan, tagPlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";
import { chooseFromMenu, GRAPH_ID, mountAt } from "./harness";
import { QueryPanel } from "../../src/features/query/QueryPanel";
import { useSessionSelector } from "../../src/features/shell/session-context";
import {
  createdBlock,
  mountPage,
  storedQuery,
  storedDefinition,
  createQuery,
} from "./query-support";

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
