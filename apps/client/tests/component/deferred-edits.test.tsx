// Edits saved after a pause reach the graph intact, and leaving never drops them.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { newDefaultQueryDocument } from "../../src/entities/default-queries";
import { findPage } from "../../src/core-port/snapshot";
import { useDeferredCommand } from "../../src/features/shell/deferred-command";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { GRAPH_ID, mountAt, type Harness } from "./harness";

async function withHome(path: string, custom?: Parameters<typeof mountAt>[1]): Promise<Harness> {
  const harness = await mountAt(path, custom);
  await harness.settle(() =>
    harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" }),
  );
  return harness;
}

const title = (harness: Harness) => findPage(harness.session.getState().snapshot, "home")?.title;

function Rename({ to }: { to: string }) {
  // Longer than the test: only leaving can write it.
  useDeferredCommand({ type: "rename_page", page_id: "home", title: to }, "home", () => {}, 60_000);
  return null;
}

describe("deferred edits", () => {
  it("writes a waiting command when its editor goes away", async () => {
    const harness = await withHome(`/g/${GRAPH_ID}/custom`, <Rename to="Renamed" />);
    await harness.settle(() => harness.router.navigate("/elsewhere"));
    await waitFor(() => expect(title(harness)).toBe("Renamed"));
  });

  it("keeps a page title typed without Enter when the page is left", async () => {
    const harness = await withHome(`/g/${GRAPH_ID}/p/home`);
    const field = await screen.findByTestId("page-title");
    const user = userEvent.setup();
    await user.click(field);
    await user.keyboard("{Control>}a{/Control}Plans");
    await harness.settle(() => harness.router.navigate("/elsewhere"));
    await waitFor(() => expect(title(harness)).toBe("Plans"));
  });

  it("saves a default query name typed faster than a round trip", async () => {
    const harness = await withHome(
      `/g/${GRAPH_ID}/custom`,
      <SettingsDialog
        graphId={GRAPH_ID}
        section="queries"
        onSection={() => {}}
        onClose={() => {}}
      />,
    );
    await harness.settle(() =>
      harness.session.execute({
        type: "create_default_query",
        default_query_id: "dq-1",
        title: "",
        document: newDefaultQueryDocument("SELECT ?block WHERE { }", undefined, "list"),
      }),
    );
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByTestId("default-query-disclose"));
    const field = await screen.findByTestId("default-query-title");
    await user.type(field, "My standing question");
    expect(field).toHaveValue("My standing question");
    await harness.settle(() => harness.router.navigate("/elsewhere"));
    await waitFor(() =>
      expect(harness.session.getState().snapshot.settings.default_queries[0].title).toBe(
        "My standing question",
      ),
    );
  });
});
