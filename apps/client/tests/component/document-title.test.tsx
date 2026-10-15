// The browser tab names the document it shows.

import { waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

it("names the tab after the open page and the journal day", async () => {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.settle(() =>
    harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" }),
  );
  await waitFor(() => expect(document.title).toBe("Home – Neoseq"));

  await harness.settle(() => harness.router.navigate(`/g/${GRAPH_ID}/journal/2026-01-15`));
  await waitFor(() => expect(document.title).toBe("Thursday, January 15, 2026 – Neoseq"));
});
