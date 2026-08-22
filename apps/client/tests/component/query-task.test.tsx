import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { dateValue, queryDocument, stringValue } from "../../src/core-port/snapshot";
import { chooseFromMenu, GRAPH_ID, mountAt } from "./harness";

async function mountProjection() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await harness.session.execute({
    type: "insert_block",
    page_id: "home",
    parent: null,
    index: 0,
    markdown: "Overdue work",
  });
  return harness;
}

describe("query and task projections", () => {
  it("keeps a query answer across page navigation and activates without a timer", async () => {
    const { session, port, router } = await mountProjection();
    port.queryResult = {
      kind: "ask",
      value: true,
      revision: 3,
      frontier: "fake-3",
    };

    await session.execute({
      type: "set_query_source",
      owner: { kind: "block", page_id: "home", id: "b-1" },
      source: "ASK { ?block ?predicate ?value }",
    });
    // Activation is a demand read. Microtasks are enough to cross the session
    // queue; advancing the old 300ms run timer must not be necessary.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(port.queryRequests).toHaveLength(1);
    expect(screen.getByTestId("query-block")).toHaveTextContent("true");

    await act(async () => {
      await router.navigate(`/g/${GRAPH_ID}/custom`);
    });
    expect(screen.queryByTestId("query-block")).not.toBeInTheDocument();

    await act(async () => {
      await router.navigate(`/g/${GRAPH_ID}/p/home`);
    });
    // The result belongs to the graph session rather than the routed component,
    // so it is present in the first render and a fresh cache hit does no work.
    expect(screen.getByTestId("query-block")).toHaveTextContent("true");
    expect(port.queryRequests).toHaveLength(1);
  });

  it("renders a reactive SELECT result inside the source block", async () => {
    const { session, port } = await mountProjection();
    port.queryResult = {
      kind: "select",
      variables: ["block", "status"],
      rows: [{
        block: {
          kind: "iri",
          value: "urn:neoseq:entity:test-graph:block:b-1",
          entity: { kind: "block", page_id: "home", id: "b-1" },
        },
        status: {
          kind: "literal",
          value: "todo",
          datatype: "http://www.w3.org/2001/XMLSchema#string",
        },
      }],
      revision: 3,
      frontier: "fake-3",
    };
    await session.execute({
      type: "set_query_source",
      owner: { kind: "block", page_id: "home", id: "b-1" },
      source: "SELECT ?block ?status WHERE { ?block ?p ?status }",
    });

    // A query that has already been written opens on its answer, not on its
    // editor: the caption names the language and the rows are there to read.
    const summary = await screen.findByTestId("query-summary");
    expect(summary).toHaveAccessibleName("SPARQL");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.getByTestId("query-block")).toHaveTextContent("b-1"));
    // Which revision answered is a diagnostic, so it is written where a test or a
    // console can read it rather than into the caption.
    expect(screen.getByTestId("query-block")).toHaveAttribute("data-revision", "3");
    // Result values do not imply a write target: source-mode SPARQL has no
    // builder provenance, even when a term happens to identify a real block.
    expect(screen.getByTestId("query-block").querySelector(
      '[data-testid^="query-edit-"]',
    )).toBeNull();

    const user = userEvent.setup();
    await user.click(summary);
    expect(await screen.findByLabelText("SPARQL source")).toHaveValue(
      "SELECT ?block ?status WHERE { ?block ?p ?status }",
    );

    await chooseFromMenu(user, screen.getByTestId("query-view-trigger"), "List");
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      expect(block && queryDocument(block.properties)?.default_view_id).toBe("list");
    });
    expect(screen.getByTestId("query-list")).toBeInTheDocument();
  });

  it("preserves unknown task values and writes the status through the inline control", async () => {
    const { session } = await mountProjection();
    await session.execute({
      type: "set_property",
      owner: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "blocked" },
    });

    // A value outside the suggested set stays legible and stays listed — the
    // control never silently rewrites it.
    const toggle = await screen.findByTestId("task-status-toggle");
    expect(toggle).toHaveAccessibleName("Task status: blocked");
    await chooseFromMenu(userEvent.setup(), toggle, "Done");
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      expect(block && stringValue(block.properties, "builtin.task-status")).toBe("done");
    });
    expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Done");
  });

  it("puts priority at the head of the line and dates in the chip strip", async () => {
    const { session } = await mountProjection();
    const owner = { kind: "block", page_id: "home", id: "b-1" } as const;
    await session.execute({
      type: "set_property",
      owner,
      key: "builtin.task-priority",
      value: { type: "string", value: "high" },
    });
    await session.execute({
      type: "set_property",
      owner,
      key: "builtin.task-deadline",
      value: { type: "date", value: "2001-01-01" },
    });

    // Priority is a positioned control beside status, not a chip under the text.
    const priority = await screen.findByTestId("task-priority-toggle");
    expect(priority).toHaveAccessibleName("Priority: High");
    expect(screen.queryByTestId("task-chip-priority")).not.toBeInTheDocument();
    // A deadline in the past on an unsettled task says so in words, and takes the
    // overdue tier's tone.
    const deadline = await screen.findByTestId("task-chip-deadline");
    expect(deadline).toHaveTextContent("Overdue");
    expect(deadline).toHaveAttribute("data-due", "overdue");
    expect(deadline).toHaveAttribute("data-palette", "danger");
    // Task facts are positioned renderers, not generic rows: the same fact is
    // never stated twice under one block.
    expect(screen.queryByTestId("prop-builtin.task-priority")).not.toBeInTheDocument();

    await chooseFromMenu(userEvent.setup(), priority, "Low");
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      expect(block && stringValue(block.properties, "builtin.task-priority")).toBe("low");
    });
  });

  it("rolls a recurring task forward instead of settling it", async () => {
    const { session } = await mountProjection();
    const owner = { kind: "block", page_id: "home", id: "b-1" } as const;
    for (const command of [
      { key: "builtin.task-status", value: { type: "string", value: "todo" } },
      { key: "builtin.task-scheduled", value: { type: "date", value: "2026-08-21" } },
      { key: "builtin.task-scheduled-time", value: { type: "string", value: "09:30" } },
      { key: "builtin.task-repeat", value: { type: "string", value: "2w" } },
    ] as const) {
      await session.execute({ type: "set_property", owner, ...command });
    }

    // The moment reads as one fact: the day, then the time of day.
    const scheduled = await screen.findByTestId("task-chip-scheduled");
    expect(scheduled).toHaveTextContent("09:30");
    expect(await screen.findByTestId("task-chip-repeat")).toHaveTextContent("Every 2 weeks");

    const toggle = await screen.findByTestId("task-status-toggle");
    await chooseFromMenu(userEvent.setup(), toggle, "Complete this one");
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      // Completing an occurrence is not finishing the task: it stays to-do and
      // the date moves by the stored interval, counted from the date that was set.
      expect(block && stringValue(block.properties, "builtin.task-status")).toBe("todo");
      expect(block && dateValue(block.properties, "builtin.task-scheduled")).toBe("2026-09-04");
    });
  });
});
