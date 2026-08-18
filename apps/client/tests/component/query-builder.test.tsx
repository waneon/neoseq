import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryDocument, type PropertyDocument } from "../../src/core-port/snapshot";
import { decodePlan } from "../../src/entities/query-plan";
import { chooseFromMenu, GRAPH_ID, mountAt } from "./harness";
import type { Harness } from "./harness";

async function mountPage(): Promise<Harness> {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await harness.session.execute({
    type: "insert_block",
    page_id: "home",
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

/** The one route to a query: `/`, never the property picker. */
async function createQuery(harness: Harness): Promise<void> {
  const user = userEvent.setup();
  const textarea = await screen.findByLabelText("Block text");
  await user.click(textarea);
  await user.type(textarea, "/query");
  const menu = await screen.findByTestId("slash-menu");
  await user.click(within(menu).getByRole("option", { name: /^Blocks/ }));
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

  it("leaves the builder for standalone SPARQL, and stays there", async () => {
    const harness = await mountPage();
    await createQuery(harness);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("query-actions-trigger"));
    await user.click(await screen.findByRole("menuitem", { name: "Edit as SPARQL…" }));

    await waitFor(() => expect(storedQuery(harness)?.plan).toBeFalsy());
    expect(screen.queryByTestId("query-builder")).not.toBeInTheDocument();
    const source = await screen.findByLabelText<HTMLTextAreaElement>("SPARQL source");
    expect(source.value).toContain("?q_subject a neo:Block .");
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
  async function withResult(): Promise<Harness> {
    const harness = await mountPage();
    harness.port.queryResult = {
      kind: "select",
      variables: ["q_subject", "text", "page"],
      rows: [
        {
          q_subject: {
            kind: "iri",
            value: "urn:neoseq:entity:test-graph:block:b-1",
            entity: { kind: "block", page_id: "home", id: "b-1" },
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
        },
      ],
      revision: 4,
      frontier: "fake-4",
    };
    await createQuery(harness);
    return harness;
  }

  it("names its columns in the product's words, not as SPARQL variables", async () => {
    await withResult();
    const table = await screen.findByTestId("query-table");
    // Row identity is carried, never shown: there is no column of block ids.
    expect(within(table).queryByRole("columnheader", { name: /q_subject/ })).not.toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Text/ })).toBeInTheDocument();
    // The text cell is the route to its own block; a page cell reads as the
    // page's name, not as its entity IRI.
    expect(within(table).getByRole("button", { name: "Ship the builder" })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Home" })).toBeInTheDocument();
  });

  it("hides a column into the saved view, so the choice survives a reload", async () => {
    const harness = await withResult();
    const user = userEvent.setup();

    await screen.findByTestId("query-table");
    await user.click(screen.getByTestId("query-col-menu-page"));
    await user.click(await screen.findByRole("menuitem", { name: "Hide column" }));

    await waitFor(() => {
      const view = storedQuery(harness)?.views.find((item) => item.id === "table");
      expect(view?.columns.find((column) => column.variable === "page")?.hidden).toBe(true);
    });
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: /Page/ })).not.toBeInTheDocument(),
    );
  });

  it("renders the list view as outline rows", async () => {
    const harness = await withResult();
    const user = userEvent.setup();
    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");

    await waitFor(() => expect(storedQuery(harness)?.default_view_id).toBe("list"));
    const list = await screen.findByTestId("query-list");
    const row = within(list).getByTestId("query-list-row");
    // The outline's own grammar: a treeitem with a bullet that opens the block.
    expect(row).toHaveAttribute("role", "treeitem");
    expect(within(row).getByRole("button", { name: /Open “Ship the builder”/ })).toBeInTheDocument();
    expect(row).toHaveTextContent("Ship the builder");
  });
});
