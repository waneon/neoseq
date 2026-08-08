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

describe("the # tag menu in a block", () => {
  it("adds an existing tag and strips the token from the Markdown", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #proj");
    const menu = await screen.findByTestId("tag-menu");
    expect(within(menu).getByRole("option", { name: /Project/ })).toBeVisible();
    await user.keyboard("{Enter}");

    // The token never reaches the Markdown, nor does the gap it sat behind.
    await waitFor(() => expect(textarea).toHaveValue("existing status"));
    const text = textarea.closest(".outline-text") as HTMLElement;
    await waitFor(() =>
      expect(within(text).getByTestId("tag-chip")).toHaveTextContent("#Project"),
    );
    // The tag's default materialized onto the block.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do"),
    );
  });

  it("creates a missing tag from the menu's create row", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #urgent");
    const menu = await screen.findByTestId("tag-menu");
    await user.click(within(menu).getByRole("option", { name: /Create tag/ }));

    await waitFor(() => expect(textarea).toHaveValue("existing status"));
    const text = textarea.closest(".outline-text") as HTMLElement;
    await waitFor(() =>
      expect(within(text).getByTestId("tag-chip")).toHaveTextContent("#urgent"),
    );
  });

  it("closes on Escape without touching the draft", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tag-menu")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("existing status #");
  });

  it("marks a tag the block already has and accepting it only removes the token", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      tag_id: "project",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #project");
    const menu = await screen.findByTestId("tag-menu");
    const option = within(menu).getByRole("option", { name: /Project/ });
    expect(option.querySelector(".tag-opt-check")).not.toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(textarea).toHaveValue("existing status"));
    const text = textarea.closest(".outline-text") as HTMLElement;
    expect(within(text).getAllByTestId("tag-chip")).toHaveLength(1);
  });
});

describe("the tags screen", () => {
  it("says how to start when the graph has no tags", async () => {
    await mountAt(`/g/${GRAPH_ID}/tags`);
    expect(await screen.findByTestId("tags-empty")).toBeVisible();
  });

  it("lists tags with their defaults and edits them through the picker", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await session.execute({
      type: "set_tag_default",
      tag_id: "project",
      key: "builtin.task-priority",
      value: { type: "string", value: "high" },
    });

    const row = await screen.findByTestId("tag-row");
    expect(row).toHaveTextContent("#Project");
    expect(
      await screen.findByTestId("tag-default-builtin.task-priority"),
    ).toHaveTextContent("High");

    // Add a second default through the same picker every other surface uses.
    await user.click(screen.getByTestId("tag-add-default"));
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Status" }));
    await user.click(within(picker).getByRole("option", { name: "To-do" }));
    expect(
      await screen.findByTestId("tag-default-builtin.task-status"),
    ).toHaveTextContent("To-do");

    // Clearing from the value stage issues remove_tag_default.
    await user.click(screen.getByTestId("tag-default-builtin.task-priority"));
    const editor = await screen.findByTestId("property-picker");
    await user.click(within(editor).getByRole("button", { name: "Clear property" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("tag-default-builtin.task-priority"),
      ).not.toBeInTheDocument(),
    );
  });
});
