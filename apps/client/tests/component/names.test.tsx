import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { nextAvailableEntityName } from "../../src/entities/names";
import { GRAPH_ID, mountAt } from "./harness";

describe("unique page and tag names", () => {
  it("shows the core conflict when a page rename duplicates another page", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/p/home`);
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({ type: "ensure_page", page_id: "other", title: "Other Page" });
    const title = await screen.findByTestId("page-title");
    const user = userEvent.setup();

    await user.clear(title);
    await user.type(title, "  OTHER   PAGE  ");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("A page with that name already exists."),
    );
    expect(title).toHaveValue("Home");
  });

  it("keeps the committed title on screen while the rename is in flight", async () => {
    const { session, port } = await mountAt(`/g/${GRAPH_ID}/p/home`);
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    const title = await screen.findByTestId("page-title");
    const user = userEvent.setup();

    // Hold the rename at the port so the in-flight window is observable at all.
    // That window is where the flicker lived: the field dropped its draft on
    // submit and fell back to the authoritative title, so the user watched
    // "Reading list" → "Home" → "Reading list" and saw their own edit undone and
    // then redone.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.beforeExecute = (command) => (command.type === "rename_page" ? held : Promise.resolve());

    await user.clear(title);
    await user.type(title, "Reading list");
    await user.keyboard("{Enter}");

    expect(title).toHaveValue("Reading list");

    port.beforeExecute = null;
    release();
    await waitFor(() => expect(title).toHaveValue("Reading list"));
  });

  it("allocates a stable unique default page name", () => {
    expect(nextAvailableEntityName("Untitled", ["untitled", "Untitled 2"])).toBe("Untitled 3");
  });
});
