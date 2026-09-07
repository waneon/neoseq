import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import type { NeoseqApp } from "../support/app";

async function openProperties(app: NeoseqApp, index: number): Promise<void> {
  await app.block(index).getByTestId("block-bullet").click({ button: "right" });
  await app.page.getByTestId("menu-properties").click();
  await expect(app.page.getByTestId("property-picker")).toBeVisible();
}

async function numberDraft(app: NeoseqApp, index: number): Promise<void> {
  await openProperties(app, index);
  const picker = app.page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill("estimate");
  await picker.getByRole("option", { name: "Create property “estimate”", exact: true }).click();
  await picker.getByRole("option", { name: "Number", exact: true }).click();
}

async function tagPicker(app: NeoseqApp, index: number): Promise<void> {
  await app.block(index).getByTestId("block-bullet").click({ button: "right" });
  await app.page.getByTestId("menu-tags").click();
  await expect(app.page.getByTestId("tag-picker")).toBeVisible();
}

async function attachTag(app: NeoseqApp, index: number): Promise<void> {
  await tagPicker(app, index);
  const picker = app.page.getByTestId("tag-picker");
  await picker.getByTestId("tag-autocomplete").fill("Project");
  await app.saved(() => app.page.getByRole("option", { name: "Project", exact: true }).click());
  await expect(picker.getByTestId("tag-chip")).toHaveText("#Project");
  await app.page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

async function tagDirectory(app: NeoseqApp): Promise<void> {
  await app.sidebar();
  await app.page.getByTestId("sidebar").getByRole("link", { name: "Tags", exact: true }).click();
  await expect(app.page.getByTestId("new-tag")).toBeVisible();
}

test("a numeric property can be emptied, restored, and removed without changing another block", async ({
  app,
  page,
}) => {
  await app.createGraph("Typed properties");
  await app.startBlock("Release estimate");
  await app.appendBlock("Independent estimate");
  const first = app.block(0).getByTestId("prop-user.estimate");
  const second = app.block(1).getByTestId("prop-user.estimate");
  const picker = page.getByTestId("property-picker");

  await numberDraft(app, 1);
  await picker.getByLabel("estimate value").fill("7");
  await app.saved(() => picker.getByTestId("property-set").click());
  await expect(second).toContainText("7");
  await expect(first).toHaveCount(0);

  await numberDraft(app, 0);
  await app.saved(() =>
    picker.getByRole("button", { name: "Add without a value", exact: true }).click(),
  );
  await expect(first).toContainText("No value");
  await page.reload();
  await expect(first).toContainText("No value");
  await expect(second).toContainText("7");

  await first.click();
  const input = picker.getByLabel("estimate value");
  await expect(input).toHaveAttribute("type", "number");
  await input.fill("3.5");
  await app.saved(() => picker.getByTestId("property-set").click());
  await expect(first).toContainText("3.5");
  await first.click();
  await expect(input).toHaveValue("3.5");
  await app.saved(() => picker.getByRole("button", { name: "Clear value", exact: true }).click());
  await expect(first).toContainText("No value");
  await page.reload();
  await expect(first).toContainText("No value");
  await expect(second).toContainText("7");

  await first.click();
  await input.fill("0");
  await app.saved(() => picker.getByTestId("property-set").click());
  await expect(first).toContainText("0");
  await first.click();
  await expect(input).toHaveValue("0");
  await app.saved(() =>
    picker.getByRole("button", { name: "Remove property", exact: true }).click(),
  );
  await expect(first).toHaveCount(0);
  await page.reload();
  await app.expectOutline(["Release estimate", "Independent estimate"]);
  await expect(first).toHaveCount(0);
  await expect(second).toContainText("7");
  await second.click();
  await expect(input).toHaveValue("7");
});

test("tag defaults copy missing properties once and detaching a tag keeps those values", async ({
  app,
  page,
}) => {
  await app.createGraph("Tag defaults");
  await app.createPage("Work");
  await app.startBlock("Inherit the default");
  await app.appendBlock("Keep my own status");
  await app.appendBlock("Untagged note");
  await openProperties(app, 1);
  const properties = page.getByTestId("property-picker");
  await properties.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => properties.getByRole("option", { name: "Done", exact: true }).click());

  await tagDirectory(app);
  await page.getByTestId("new-tag").click();
  const name = page.getByTestId("new-tag-name");
  await name.fill("Project");
  const group = page.getByTestId("new-tag-group");
  await group.fill("Delivery");
  await expect(group).toBeFocused();
  await expect(page.getByRole("listbox", { name: "Group", exact: true })).toBeVisible();
  // Submit directly while suggestions are open: collapsing them on pointer-down
  // must not move the button away before the same click reaches pointer-up.
  await app.saved(() => page.getByTestId("new-tag-submit").click());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("tag-row-link")).toHaveText("Project");
  await page.getByTestId("tag-row-link").click();
  await expect(page.getByTestId("tag-title")).toHaveValue("Project");
  await expect(page.getByTestId("tag-page-group")).toHaveText("Delivery");
  await page.getByTestId("tag-add-default").click();
  await properties.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => properties.getByRole("option", { name: "To-do", exact: true }).click());
  await expect(page.getByTestId("tag-default-builtin.task-status")).toHaveAccessibleName(
    "Status: To-do",
  );

  await app.sidebar();
  await page.getByTestId("sidebar").getByRole("link", { name: "Work", exact: true }).click();
  await attachTag(app, 0);
  await attachTag(app, 1);
  const inherited = app.block(0).getByTestId("task-status-toggle");
  const existing = app.block(1).getByTestId("task-status-toggle");
  await expect(inherited).toHaveAccessibleName("Task status: To-do");
  await expect(existing).toHaveAccessibleName("Task status: Done");
  await expect(app.block(2).getByTestId("tag-chip")).toHaveCount(0);
  await expect(app.block(2).getByTestId("task-status-toggle")).toHaveCount(0);

  await app.block(0).getByTestId("tag-chip").click();
  await expect(page.getByTestId("tag-title")).toHaveValue("Project");
  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-row")).toHaveCount(2);
  await expect(query).toContainText("Inherit the default");
  await expect(query).toContainText("Keep my own status");
  await expect(query).not.toContainText("Untagged note");
  await page.getByTestId("tag-defaults-toggle").click();
  await page.getByTestId("tag-default-builtin.task-status").click();
  await app.saved(() => properties.getByRole("option", { name: "Doing", exact: true }).click());
  await query.getByRole("button", { name: "Open “Inherit the default”", exact: true }).click();
  await expect(inherited).toHaveAccessibleName("Task status: To-do");
  await expect(existing).toHaveAccessibleName("Task status: Done");

  await tagPicker(app, 0);
  const tags = page.getByTestId("tag-picker");
  await app.saved(() =>
    tags.getByRole("button", { name: "Remove tag Project", exact: true }).click(),
  );
  await expect(tags.getByTestId("tag-chip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tags).toHaveCount(0);
  await expect(app.block(0).getByTestId("tag-chip")).toHaveCount(0);
  await expect(inherited).toHaveAccessibleName("Task status: To-do");
  await app.block(1).getByTestId("tag-chip").click();
  await expect(query.getByTestId("query-row")).toHaveCount(1);
  await expect(query).toContainText("Keep my own status");
  await expect(query).not.toContainText("Inherit the default");
  await page.reload();
  await expect(query.getByTestId("query-row")).toHaveCount(1);
  await page.getByTestId("tag-defaults-toggle").click();
  await expect(page.getByTestId("tag-default-builtin.task-status")).toHaveAccessibleName(
    "Status: Doing",
  );
  await query.getByRole("button", { name: "Open “Keep my own status”", exact: true }).click();
  await page.reload();
  await app.expectOutline(["Inherit the default", "Keep my own status", "Untagged note"]);
  await expect(inherited).toHaveAccessibleName("Task status: To-do");
  await expect(existing).toHaveAccessibleName("Task status: Done");
  await expect(app.block(0).getByTestId("tag-chip")).toHaveCount(0);
  await expect(app.block(1).getByTestId("tag-chip")).toHaveText("#Project");
  await expect(app.block(2).getByTestId("tag-chip")).toHaveCount(0);
  await expect(app.block(2).getByTestId("task-status-toggle")).toHaveCount(0);
});
