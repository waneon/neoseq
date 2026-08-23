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
  addDefaultQuery,
  defaultQueries,
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

function seed(query: Partial<DefaultQuery> = {}): DefaultQuery {
  const created = addDefaultQuery({
    title: "Scheduled",
    source: SOURCE,
    layout: "list",
    ...query,
  });
  if (!created) throw new Error("the seed was refused");
  return created;
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
  it("offers the same two entrances the outline's `/` does", async () => {
    const user = userEvent.setup();
    await mountAt(`/g/${GRAPH_ID}/custom`, settings);

    await user.click(screen.getByTestId("add-default-query"));
    const [built] = defaultQueries();
    // A built query stores its plan beside the SPARQL it compiled to, exactly as
    // a query owned by a block does — the graph's shape, kept in the browser.
    expect(decodePlan(built.plan!.payload, built.plan!.version)?.subject).toBe("block");
    expect(built.source).toContain("?q_subject a neo:Block .");
    expect(await screen.findByTestId("query-builder")).toBeInTheDocument();

    await user.click(screen.getByTestId("add-default-sparql"));
    const written = defaultQueries()[1];
    // Hand-written SPARQL is its own entrance, never a conversion: the editor
    // opens empty and waits for the person who asked for it.
    expect(written.plan).toBeUndefined();
    expect(await screen.findByTestId("default-query-source")).toHaveValue("");
  });

  it("names itself after the question until the reader names it", async () => {
    const user = userEvent.setup();
    await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    await user.click(screen.getByTestId("add-default-query"));

    const title = screen.getByTestId("default-query-title");
    expect(title).toHaveAttribute("placeholder", "Blocks");

    await user.type(title, "Today");
    expect(defaultQueries()[0].title).toBe("Today");
  });

  it("says how much a hand-written query finds, where it can still be fixed", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    oneRow(harness);

    await user.click(screen.getByTestId("add-default-sparql"));
    const editor = screen.getByTestId("default-query-source");
    await user.click(editor);
    await user.paste(SOURCE);
    // Committed on blur, so a half-written query does not spend the pause
    // between two words as a parse error.
    await user.tab();

    await waitFor(() =>
      expect(screen.getByTestId("default-query-count")).toHaveTextContent("1 result"));
    expect(defaultQueries()[0].source).toBe(SOURCE);
  });

  it("reports a failing query as a failure rather than as an empty answer", async () => {
    const user = userEvent.setup();
    const harness = await mountAt(`/g/${GRAPH_ID}/custom`, settings);
    harness.port.query = () => Promise.reject(new CorePortFailure({
      code: "invalid_query",
      message: "unreadable",
      retryable: false,
    }));

    await user.click(screen.getByTestId("add-default-sparql"));
    await user.click(screen.getByTestId("default-query-source"));
    await user.paste("SELECT ?x WHERE {");
    await user.tab();

    // The count is the first thing that says so, and the reason is stated beside
    // the editor that can fix it rather than only under the journal.
    await waitFor(() =>
      expect(screen.getByTestId("default-query-count")).toHaveTextContent("Query failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The query could not be read.");
  });

  it("orders and deletes from the row's own menu", async () => {
    const user = userEvent.setup();
    seed({ title: "First" });
    seed({ title: "Second" });
    await mountAt(`/g/${GRAPH_ID}/custom`, settings);

    await user.click(screen.getAllByTestId("default-query-actions")[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(defaultQueries().map((query) => query.title)).toEqual(["Second", "First"]);

    await user.click(screen.getAllByTestId("default-query-actions")[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Delete query" }));
    expect(defaultQueries().map((query) => query.title)).toEqual(["First"]);
  });
});

describe("reading a standing question", () => {
  it("answers under today's journal, captioned by the name the reader gave it", async () => {
    seed();
    const harness = await mountAt(`/g/${GRAPH_ID}/journal`);
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
    seed();
    await mountAt(`/g/${GRAPH_ID}/journal`);
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
    seed();
    await mountAt(`/g/${GRAPH_ID}/journal/2026-01-15`);
    await waitFor(() => expect(screen.getByTestId("journal-title")).toBeInTheDocument());
    expect(screen.queryByTestId("journal-queries")).not.toBeInTheDocument();
  });

  it("is one execution, whether it is being read or edited", async () => {
    seed();
    const harness = await mountAt(
      `/g/${GRAPH_ID}/journal`,
      <>
        <JournalView />
        {settings}
      </>,
    );
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
