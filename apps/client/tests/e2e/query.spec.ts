import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import type { NeoseqApp } from "../support/app";

async function choose(page: Page, trigger: Locator, value: string): Promise<void> {
  await trigger.click();
  await page
    .getByRole("option", { name: value, exact: true })
    .or(page.getByRole("menuitemradio", { name: value, exact: true }))
    .click();
}

async function status(app: NeoseqApp, page: Page, index: number, value: string): Promise<void> {
  await app.block(index).getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-properties").click();
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => picker.getByRole("option", { name: value, exact: true }).click());
  await expect(picker).toHaveCount(0);
}

test("a saved task query selects exact records, orders them, and edits their source", async ({
  app,
  page,
}, testInfo) => {
  await app.createGraph("Task query");
  await app.createPage("Capture");
  await app.startBlock("Zulu task");
  await app.appendBlock("Alpha task");
  await app.appendBlock("Completed task");
  await app.appendBlock("Plain note");
  await status(app, page, 0, "To-do");
  await status(app, page, 1, "To-do");
  await status(app, page, 2, "Done");

  await app.createPage("Task board");
  await app.startBlock("");
  const editor = app.editors.first();
  await editor.click();
  await editor.pressSequentially("/quer");
  await app.saved(() =>
    page
      .getByTestId("slash-menu")
      .getByRole("option", { name: /^Query/ })
      .click(),
  );
  const query = page.getByTestId("query-block");
  const builder = query.getByTestId("query-builder");
  await expect(builder).toBeVisible();
  await app.saved(() => builder.getByTestId("qb-add-condition").click());
  await app.saved(() =>
    choose(page, builder.getByRole("combobox", { name: "Field", exact: true }), "Status"),
  );
  await expect(builder.getByRole("combobox", { name: "Value", exact: true })).toHaveText("To-do");

  const table = query.getByTestId("query-table");
  const rows = table.getByTestId("query-row");
  await expect(rows).toHaveCount(2);
  await expect(table).not.toContainText("Completed task");
  await expect(table).not.toContainText("Plain note");
  await app.saved(() => table.getByRole("button", { name: "Text", exact: true }).click());
  const texts = table.getByTestId("query-edit-text");
  await expect(texts.nth(0)).toHaveValue("Alpha task");
  await expect(texts.nth(1)).toHaveValue("Zulu task");
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await testInfo.attach("query-builder-and-results-a11y", {
    body: JSON.stringify(accessibility.violations, null, 2),
    contentType: "application/json",
  });
  expect(accessibility.violations).toEqual([]);

  await texts.first().click();
  const resultEditor = query.getByTestId("query-markdown-editor");
  await app.saved(async () => {
    await resultEditor.fill("Beta task");
    await resultEditor.press("Enter");
  });
  await expect(texts.first()).toHaveValue("Beta task");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");

  // A fresh Worker must reconstruct both the saved question and its answer.
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(texts.nth(0)).toHaveValue("Beta task");
  await expect(texts.nth(1)).toHaveValue("Zulu task");

  await app.saved(() => choose(page, query.getByTestId("query-view-trigger"), "List"));
  const listRows = query.getByTestId("query-list-row");
  await expect(listRows).toHaveCount(2);
  const beta = listRows.filter({ hasText: "Beta task" });
  await app.saved(() => choose(page, beta.getByTitle("Edit Task status"), "Done"));
  await expect(listRows).toHaveCount(1);
  await expect(listRows).toContainText("Zulu task");
  await expect(query).not.toContainText("Beta task");

  await query.getByRole("button", { name: "Open “Zulu task”", exact: true }).click();
  await expect(page.getByTestId("page-title")).toHaveValue("Capture");
  await app.expectOutline(["Zulu task", "Beta task", "Completed task", "Plain note"]);
  await expect(app.block(0).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: To-do",
  );
  await expect(app.block(1).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Done",
  );
  await expect(app.block(2).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Done",
  );
  await expect(app.block(3).getByTestId("task-status-toggle")).toHaveCount(0);

  await app.saved(() => choose(page, app.block(1).getByTestId("task-status-toggle"), "To-do"));
  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveValue("Task board");
  await expect(listRows).toHaveCount(2);
  await expect(listRows.filter({ hasText: "Beta task" })).toHaveCount(1);
  await expect(listRows.filter({ hasText: "Zulu task" })).toHaveCount(1);
  await page.reload();
  await expect(listRows).toHaveCount(2);
  await expect(query).not.toContainText("Completed task");
  await expect(query).not.toContainText("Plain note");
});
