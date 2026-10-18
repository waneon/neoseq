// An empty answer stays on screen while a refresh runs, as rows do, so the
// content below the query does not jump on every save.

import { screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { createQuery, mountPage } from "./query-support";

it("keeps an empty answer in place while it refreshes", async () => {
  const harness = await mountPage();
  await createQuery(harness);
  const output = screen.getByTestId("query-output");
  await waitFor(() => expect(output).toHaveAttribute("aria-busy", "false"));
  expect(screen.getByTestId("query-empty")).toBeInTheDocument();

  const query = harness.port.query.bind(harness.port);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  harness.port.query = async (request) => {
    await held;
    return query(request);
  };
  await harness.settle(() =>
    harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 1,
      markdown: "Unrelated note",
    }),
  );
  await waitFor(() => expect(output).toHaveAttribute("aria-busy", "true"));
  expect(screen.getByTestId("query-empty")).toBeInTheDocument();

  release();
  await waitFor(() => expect(output).toHaveAttribute("aria-busy", "false"));
  expect(screen.getByTestId("query-empty")).toBeInTheDocument();
});
