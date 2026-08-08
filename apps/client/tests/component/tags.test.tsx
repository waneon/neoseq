// First-class tag chips + default materialization from TagRecord defaults.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GRAPH_ID, mountAt, openBlockMenu } from "./harness";

async function mountTagged() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session } = harness;
  await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
  await session.execute({
    type: "set_tag_default",
    tag_id: "project",
    key: "builtin.task-status",
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

describe("first-class tags and tag defaults", () => {
  it("copies defaults on tag but never overwrites existing block values", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    // The block already tracks its own status.
    await session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "doing" },
    });

    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    const autocomplete = within(picker).getByTestId("tag-autocomplete");
    await user.type(autocomplete, "Proj");
    await user.click(await screen.findByRole("option", { name: "Project" }));

    await waitFor(() => expect(within(picker).getByTestId("tag-chip")).toHaveTextContent("#Project"));
    // Existing value wins over the tag default.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing"),
    );
  });

  it("materializes missing defaults and supports chip removal", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      tag_id: "project",
    });

    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    // The default was copied because the block had no builtin.task-status.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do"),
    );

    await user.click(within(picker).getByRole("button", { name: "Remove tag Project" }));
    await waitFor(() =>
      expect(within(picker).queryByTestId("tag-chip")).not.toBeInTheDocument(),
    );
    // Copied properties are plain properties: removing the tag keeps them.
    expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  });

  it("does not offer a duplicate tag create action", async () => {
    await mountTagged();
    const user = userEvent.setup();
    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    await user.type(within(picker).getByTestId("tag-autocomplete"), "  project  ");

    expect(await screen.findByRole("option", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Create tag/ })).not.toBeInTheDocument();
  });
});
