import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { stringValue } from "../../src/core-port/snapshot";
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
      type: "set_property",
      owner: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.query-source",
      value: { type: "string", value: "SELECT ?block ?status WHERE { ?block ?p ?status }" },
    });

    expect(await screen.findByLabelText("SPARQL source")).toHaveValue(
      "SELECT ?block ?status WHERE { ?block ?p ?status }",
    );
    await waitFor(() => expect(screen.getByTestId("query-block")).toHaveTextContent("b-1"));
    expect(screen.getByTestId("query-block")).toHaveTextContent("revision 3");
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

  it("shows priority and dates as chips that open the picker on their key", async () => {
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

    const priority = await screen.findByTestId("task-chip-priority");
    expect(priority).toHaveTextContent("High");
    // A deadline in the past on an unsettled task says so in words.
    expect(await screen.findByTestId("task-chip-deadline")).toHaveTextContent("Overdue");
    // Task facts are positioned renderers, not generic rows: the same fact is
    // never stated twice under one block.
    expect(screen.queryByTestId("prop-builtin.task-priority")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(priority);
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Low" }));
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      expect(block && stringValue(block.properties, "builtin.task-priority")).toBe("low");
    });
  });
});
