// Tag chips + default materialization: AddTag copies missing default keys
// only, repeated tags stay editable as ordinary properties.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

async function mountTagged() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session } = harness;
  await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await session.execute({ type: "ensure_page", page_id: "project", title: "Project" });
  await session.execute({
    type: "set_page_default",
    page_id: "project",
    key: "task.status",
    value: { type: "string", value: "todo" },
  });
  await session.execute({
    type: "insert_block",
    page_id: "home",
    parent: null,
    index: 0,
    markdown: "existing status",
  });
  await waitFor(() => expect(screen.getByTestId("page-title")).toHaveValue("Home"));
  return harness;
}

describe("tags and page defaults", () => {
  it("copies defaults on tag but never overwrites existing block values", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    // The block already tracks its own status.
    await session.execute({
      type: "set_property",
      entity: { kind: "block", id: "b-1" },
      key: "task.status",
      value: { type: "string", value: "doing" },
    });

    await user.click(await screen.findByTestId("block-menu"));
    await user.click(await screen.findByTestId("menu-properties"));
    const inspector = await screen.findByTestId("block-inspector");
    const autocomplete = within(inspector).getByTestId("page-autocomplete");
    await user.type(autocomplete, "Proj");
    await user.click(await screen.findByRole("option", { name: "Project" }));

    await waitFor(() => expect(within(inspector).getByTestId("tag-chip")).toHaveTextContent("#Project"));
    // Existing value wins over the page default.
    await waitFor(() =>
      expect(within(inspector).getByLabelText("task.status value")).toHaveValue("doing"),
    );
  });

  it("materializes missing defaults and supports chip removal", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    await session.execute({ type: "add_tag", block_id: "b-1", page_id: "project" });

    await user.click(await screen.findByTestId("block-menu"));
    await user.click(await screen.findByTestId("menu-properties"));
    const inspector = await screen.findByTestId("block-inspector");
    // The default was copied because the block had no task.status.
    await waitFor(() =>
      expect(within(inspector).getByLabelText("task.status value")).toHaveValue("todo"),
    );

    await user.click(within(inspector).getByRole("button", { name: "Remove tag Project" }));
    await waitFor(() =>
      expect(within(inspector).queryByTestId("tag-chip")).not.toBeInTheDocument(),
    );
    // Copied properties are plain properties: removing the tag keeps them.
    expect(within(inspector).getByLabelText("task.status value")).toHaveValue("todo");
  });
});
