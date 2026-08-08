import { screen, waitFor } from "@testing-library/react";
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
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.query-source",
      value: { type: "string", value: "SELECT ?block ?status WHERE { ?block ?p ?status }" },
    });

    expect(await screen.findByLabelText("SPARQL source")).toHaveValue(
      "SELECT ?block ?status WHERE { ?block ?p ?status }",
    );
    await waitFor(() => expect(screen.getByTestId("query-block")).toHaveTextContent("b-1"));
    expect(screen.getByTestId("query-block")).toHaveTextContent("revision 3");
  });

  it("preserves unknown task values and writes controls through ordinary properties", async () => {
    const { session } = await mountProjection();
    await session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "blocked" },
    });

    const status = await screen.findByLabelText("Task status");
    expect(status).toHaveTextContent("blocked");
    await chooseFromMenu(userEvent.setup(), status, "done");
    await waitFor(() => {
      const block = session.getState().snapshot.pages[0]?.blocks[0];
      expect(block && stringValue(block.properties, "builtin.task-status")).toBe("done");
    });
  });
});
