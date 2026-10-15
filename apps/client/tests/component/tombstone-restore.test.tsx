// Restore is offered for a deleted document, not for an address that named none.

import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("offers Restore only for a page that was deleted", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/never-existed`);
  expect(await screen.findByTestId("tombstone")).toBeInTheDocument();
  expect(screen.queryByTestId("restore-page")).toBeNull();

  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "gone", title: "Gone" });
    await harness.session.execute({ type: "delete_page", page_id: "gone" });
  });
  await harness.settle(() => harness.router.navigate(`/g/${GRAPH_ID}/p/gone`));
  expect(await screen.findByTestId("restore-page")).toBeInTheDocument();
});
