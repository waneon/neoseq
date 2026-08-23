// The standing questions: written in Settings, read under today's journal.
//
// The two halves are deliberately separate surfaces, so the tests worth having
// are the ones that pin the seam between them — that Settings is the only place
// the question can be changed, that the journal states it and answers it, and
// that both are talking about one execution rather than two.

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CorePortFailure } from "../../src/core-worker";
import {
  newDefaultQueryDocument,
  type DefaultQuery,
} from "../../src/entities/default-queries";
import { decodePlan } from "../../src/entities/query-plan";
import { resetAppSettingsCache } from "../../src/entities/settings";
import { JournalView } from "../../src/features/journal/JournalView";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { GRAPH_ID, mountAt, type Harness } from "./harness";

const SOURCE = "PREFIX neo: <urn:neoseq:vocab:v1:>\nSELECT ?block WHERE { ?block a neo:Block . }";

const settings = (
  <SettingsDialog
    graphId={GRAPH_ID}
    section="queries"
    onSection={() => {}}
    onClose={() => {}}
  />
);

function queries(harness: Harness): DefaultQuery[] {
  return harness.session.getState().snapshot.settings.default_queries;
}

async function seed(
  harness: Harness,
  query: { title?: string; source?: string; layout?: "list" | "table" } = {},
): Promise<DefaultQuery> {
  const id = `dq-${crypto.randomUUID()}`;
  await harness.session.execute({
    type: "create_default_query",
    default_query_id: id,
    title: query.title ?? "Scheduled",
    document: newDefaultQueryDocument(query.source ?? SOURCE, undefined, query.layout ?? "list"),
  });
  return queries(harness).find((entry) => entry.id === id)!;
}

/** One row, one block, so a `SELECT ?block` has something true to answer with. */
function oneRow(harness: Harness): void {
  harness.port.queryResult = {
    kind: "select",
    variables: ["block"],
    rows: [{
      block: {
        kind: "iri",
        value: `urn:neoseq:entity:${GRAPH_ID}:block:b-1`,
        entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      },
    }],
    revision: 2,
    frontier: "fake-2",
  };
}

beforeEach(() => {
  localStorage.clear();
  resetAppSettingsCache();
});
afterEach(() => {
  localStorage.clear();
  resetAppSettingsCache();
});

describe("writing a standing question", () => {
  it("imports pre-v4 browser queries only after explicit consent", async () => {
    localStorage.setItem("neoseq.settings.v1", JSON.stringify({
      defaultQueries: [{
        id: "dq-legacy",
        title: "Legacy",
        source: SOURCE,
        layout: "table",
      }],
    }));
    resetAppSettingsCache();
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);

    expect(queries(harness)).toHaveLength(0);
    await user.click(screen.getByTestId("import-legacy-default-queries"));
    await waitFor(() => expect(queries(harness)).toHaveLength(1));
    expect(queries(harness)[0].title).toBe("Legacy");
    expect(queries(harness)[0].document.views[0].kind).toBe("table");
    expect(JSON.parse(localStorage.getItem("neoseq.settings.v1") ?? "{}"))
      .not.toHaveProperty("defaultQueries");
  });

  it("keeps the browser source until an applied import is durable", async () => {
    localStorage.setItem("neoseq.settings.v1", JSON.stringify({
      defaultQueries: [{
        id: "dq-legacy",
        title: "Legacy",
        source: SOURCE,
        layout: "list",
      }],
    }));
    resetAppSettingsCache();
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    harness.port.failNextSave = {
      code: "storage_full",
      message: "full",
      retryable: true,
    };

    await user.click(screen.getByTestId("import-legacy-default-queries"));
    await waitFor(() => expect(queries(harness)).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem("neoseq.settings.v1") ?? "{}"))
      .toHaveProperty("defaultQueries");

    await harness.session.retry();
    await waitFor(() => expect(
      JSON.parse(localStorage.getItem("neoseq.settings.v1") ?? "{}"),
    ).not.toHaveProperty("defaultQueries"));
  });

  it("offers the one entrance the outline's `/` does, and only that one", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);

    await user.click(screen.getByTestId("add-default-query"));
    const [built] = queries(harness);
    // A built query stores its plan beside the SPARQL it compiled to, exactly as
    // a query owned by a block does — one canonical shape in the graph.
    expect(decodePlan(
      built.document.plan!.payload,
      built.document.plan!.version,
    )?.subject).toBe("block");
    expect(built.document.source).toContain("?q_subject a neo:Block .");
    expect(await screen.findByTestId("query-builder")).toBeInTheDocument();

    // There is no second authoring grammar, here or anywhere: every standing
    // question is a built one, and nothing offers a box to type SPARQL into.
    expect(screen.queryByTestId("add-default-sparql")).not.toBeInTheDocument();
    expect(screen.queryByTestId("default-query-source")).not.toBeInTheDocument();
  });

  it("chooses a table's columns here, because here is the only place that owns it", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    await user.click(screen.getByTestId("add-default-query"));

    // A list draws entities and states everything; only a table has columns to
    // choose between, so only a table is asked.
    expect(screen.queryByTestId("query-columns-trigger")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("default-query-layout-table"));

    await user.click(screen.getByTestId("query-columns-trigger"));
    const panel = await screen.findByTestId("query-columns-panel");
    await user.click(
      within(panel).getByTestId("query-column-toggle-property:builtin.task-status"),
    );

    await waitFor(() => {
      const [query] = queries(harness);
      const plan = decodePlan(query.document.plan!.payload, query.document.plan!.version);
      expect(plan?.columns.some((column) =>
        column.source.kind === "property" && column.source.key === "builtin.task-status"))
        .toBe(true);
      // The plan and the SPARQL it compiles to are written together, never apart.
      expect(query.document.source).toContain("prop:builtin.task-status");
    });
  });

  it("names itself after the question until the reader names it", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    await user.click(screen.getByTestId("add-default-query"));

    const title = screen.getByTestId("default-query-title");
    expect(title).toHaveAttribute("placeholder", "Blocks");

    await user.type(title, "Today");
    await waitFor(() => expect(queries(harness)[0].title).toBe("Today"));
  });

  it("says how much a standing question finds, at the size the journal prints it", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    oneRow(harness);

    await user.click(screen.getByTestId("add-default-query"));

    await waitFor(() =>
      expect(screen.getByTestId("default-query-count")).toHaveTextContent("1 result"));
  });

  it("reports a failing query as a failure rather than as an empty answer", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    harness.port.query = () => Promise.reject(new CorePortFailure({
      code: "invalid_query",
      message: "unreadable",
      retryable: false,
    }));

    await user.click(screen.getByTestId("add-default-query"));

    // The count is the first thing that says so, and the reason is stated beside
    // the editor that can fix it rather than only under the journal.
    await waitFor(() =>
      expect(screen.getByTestId("default-query-count")).toHaveTextContent("Query failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The query could not be read.");
  });

  it("orders and deletes from the row's own menu", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    await seed(harness, { title: "First" });
    await seed(harness, { title: "Second" });

    await user.click(screen.getAllByTestId("default-query-actions")[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(queries(harness).map((query) => query.title)).toEqual(["Second", "First"]);

    await user.click(screen.getAllByTestId("default-query-actions")[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Delete query" }));
    expect(queries(harness).map((query) => query.title)).toEqual(["First"]);
  });
});

describe("reading a standing question", () => {
  it("answers under today's journal, captioned by the name the reader gave it", async () => {
    const harness = await mountAt(`/g/${GRAPH_ID}/journal`);
    await seed(harness);
    const section = await screen.findByTestId("journal-queries");
    expect(within(section).getByTestId("query-summary")).toHaveTextContent("Scheduled");

    // A canonical change reruns what is mounted, which is how a standing question
    // stays current while the day is being written.
    oneRow(harness);
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await waitFor(() =>
      expect(within(section).getByTestId("query-count")).toHaveTextContent("1 result"));
  });

  it("opens no editor there, and says where the editor is", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/journal`);
    await seed(harness);
    const section = await screen.findByTestId("journal-queries");

    // The caption is a caption: there is nothing on this surface to disclose,
    // because the question is not written here.
    expect(within(section).getByTestId("query-summary").tagName).toBe("SPAN");
    // Nor is there anything to lay out — every row of that menu writes a document
    // this surface does not own.
    expect(within(section).queryByTestId("query-view-trigger")).not.toBeInTheDocument();

    await user.click(within(section).getByTestId("query-actions-trigger"));
    expect(await screen.findByTestId("journal-query-settings"))
      .toHaveTextContent("Edit in Settings");
    // What runs is still readable, which is the only way to check a question
    // whose editor is elsewhere.
    await user.click(await screen.findByRole("menuitem", { name: "Show SPARQL" }));
    expect(await screen.findByTestId("query-compiled")).toHaveTextContent("a neo:Block");
  });

  it("stands only on the day it is standing in", async () => {
    const harness = await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await seed(harness);
    await waitFor(() => expect(screen.getByTestId("journal-title")).toBeInTheDocument());
    expect(screen.queryByTestId("journal-queries")).not.toBeInTheDocument();
  });

  it("is one execution, whether it is being read or edited", async () => {
    const harness = await mountAt(
      `/g/${GRAPH_ID}/journal`,
      <>
        <JournalView />
        {settings}
      </>,
    );
    await seed(harness);
    expect(screen.getByTestId("journal-queries")).toBeInTheDocument();
    expect(screen.getByTestId("settings-default-queries")).toBeInTheDocument();

    // The journal's answer and the editor's count are the same question under one
    // key, so a canonical change costs one execution rather than one per surface.
    const before = harness.port.queryRequests.length;
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await waitFor(() =>
      expect(harness.port.queryRequests.length).toBeGreaterThan(before));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(harness.port.queryRequests).toHaveLength(before + 1);
  });
});
