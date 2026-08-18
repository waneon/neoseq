import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  chooseFromMenu,
  createGraph,
  openBlockProperties,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

/** Builtin keys are searched by storage name but read by their product names. */
const DISPLAY_NAME: Record<string, string> = {
  "builtin.task-status": "Status",
};

async function setKnownProperty(page: Page, key: string, value: string): Promise<void> {
  const name = DISPLAY_NAME[key] ?? key;
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill(key);
  await picker.getByRole("option", { name, exact: true }).click();
  if (key === "builtin.task-status") {
    // Status choices carry their localized labels and shape glyphs.
    await picker.getByRole("option", { name: value, exact: true }).click();
  } else {
    await picker.getByLabel(`${name} value`).fill(value);
    await picker.getByTestId("property-set").click();
  }
  await expect(picker).toHaveCount(0);
}

/** Chooses from one of the builder's dropdowns, which are all `MenuSelect`. */
async function chooseInBuilder(page: Page, label: string, option: string): Promise<void> {
  await page.getByTestId("query-builder").getByRole("button", { name: label }).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

test("query-task projections share ordinary properties and the SPARQL index", async ({ page }) => {
  await createGraph(page, "Query Task Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Ship the query engine");

  await openBlockProperties(page);
  await setKnownProperty(page, "builtin.task-status", "To-do");

  const status = page.getByTestId("task-status-toggle");
  await expect(status).toHaveAccessibleName("Task status: To-do");
  await chooseFromMenu(page, status, "Done");
  await awaitSaved(page);
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Done");

  // The query property has no picker route: `/` is the only way to make one.
  // (A `user.query` key of one's own is still offerable — that is a different
  // property that happens to share a word.)
  await openBlockProperties(page, 0);
  await page.getByTestId("property-picker").getByLabel("Property key").fill("query");
  await expect(
    page.getByTestId("property-picker").getByRole("option", { name: "Query", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  const taskText = page.locator(".outline-input").first();
  await taskText.click();
  await taskText.press("End");
  await taskText.press("Enter");
  await page.keyboard.type("/query");
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Blocks/ }).click();

  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-builder")).toBeVisible();
  await awaitSaved(page);

  // Narrowing the plan narrows the SPARQL the core actually runs.
  await query.getByTestId("qb-add-condition").click();
  await chooseInBuilder(page, "Field", "Status");
  await chooseInBuilder(page, "Value", "Done");
  await awaitSaved(page);

  const table = query.getByTestId("query-table");
  await expect(table).toContainText("Ship the query engine");
  await expect(table.getByRole("columnheader", { name: /Text/ })).toBeVisible();

  // The compiled source is available, and it is what ran.
  await query.getByTestId("query-actions-trigger").click();
  await page.getByRole("menuitem", { name: "Show SPARQL" }).click();
  await expect(query.getByTestId("query-compiled")).toContainText("prop:builtin.task-status");

  await expect(query.getByTestId("query-view-trigger")).toContainText("Table");
  await chooseFromMenu(page, query.getByTestId("query-view-trigger"), "List");
  await expect(query.getByTestId("query-list")).toBeVisible();
  await expect(query.getByTestId("query-list-row").first()).toContainText("Ship the query engine");

  // Hiding a column is saved view data, so it survives a reload.
  await chooseFromMenu(page, query.getByTestId("query-view-trigger"), "Table");
  await query.getByTestId("query-col-menu-page").click();
  await page.getByRole("menuitem", { name: "Hide column" }).click();
  await awaitSaved(page);
  await page.reload();
  const reloaded = page.getByTestId("query-block");
  await expect(reloaded.getByTestId("query-table")).toBeVisible();
  await expect(reloaded.getByRole("columnheader", { name: /Page/ })).toHaveCount(0);
});
