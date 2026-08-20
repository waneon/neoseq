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
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Query/ }).click();

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
  // `Status is Done` matches exactly one block, so waiting for one row is what
  // "the condition narrowed the answer" actually means. Waiting only for the
  // task's own text to appear does not: the unfiltered answer contains it too,
  // alongside the empty block the query itself lives on, and the next line
  // addresses "the text cell" in the singular.
  await expect(table.getByTestId("query-edit-text")).toHaveCount(1);

  // A result cell edits the canonical block; the query remains only the lens
  // that finds it. Its query-level draft also survives a presentation change.
  await table.getByTestId("query-edit-text").click();
  const resultEditor = query.getByTestId("query-markdown-editor");
  await expect(resultEditor).toHaveValue("Ship the query engine");
  await resultEditor.fill("Ship editable query results");
  await chooseFromMenu(page, query.getByTestId("query-view-trigger"), "List");
  await expect(query.getByTestId("query-list")).toBeVisible();
  const listEditor = query.getByTestId("query-markdown-editor");
  await expect(listEditor).toHaveValue("Ship editable query results");
  await listEditor.press("Enter");
  await awaitSaved(page);
  await expect(page.locator(".outline-input").first()).toHaveValue("Ship editable query results");
  await expect(query.getByTestId("query-list-row").first()).toContainText("Ship editable query results");

  // The compiled source is available, and it is what ran.
  await query.getByTestId("query-actions-trigger").click();
  await page.getByRole("menuitem", { name: "Show SPARQL" }).click();
  await expect(query.getByTestId("query-compiled")).toContainText("prop:builtin.task-status");

  // Hiding a column is saved view data, so it survives a reload. The view control
  // is icon-only now — the answer below it already says whether it is a table —
  // so the state it carries is the icon it draws.
  await expect(query.getByTestId("query-view-trigger")).toHaveAttribute("data-view", "list");
  await chooseFromMenu(page, query.getByTestId("query-view-trigger"), "Table");
  await query.getByTestId("query-col-menu-page").click();
  await page.getByRole("menuitem", { name: "Hide column" }).click();
  await awaitSaved(page);
  await page.reload();
  const reloaded = page.getByTestId("query-block");
  await expect(reloaded.getByTestId("query-table")).toBeVisible();
  await expect(reloaded.getByRole("columnheader", { name: /Page/ })).toHaveCount(0);
});

// The order a reader puts a result in is a list, and it is saved view data like
// every other shape they give a table.
test("a result's order accumulates across headings and survives a reload", async ({ page }) => {
  await createGraph(page, "Query Sort Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "alpha");
  const first = page.getByLabel("Block text").first();
  await first.click();
  await first.press("End");
  await first.press("Enter");
  await typeInFocusedBlock(page, "beta");

  const line = page.getByLabel("Block text").nth(1);
  await line.click();
  await line.press("End");
  await line.press("Enter");
  await page.keyboard.type("/query");
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Query/ }).click();

  const query = page.getByTestId("query-block");
  const table = query.getByTestId("query-table");
  await expect(table).toBeVisible();

  // One press orders by that column; the next adds a tie-breaker rather than
  // replacing the first choice.
  await table.getByRole("button", { name: "Text", exact: true }).click();
  await table.getByRole("button", { name: "Page", exact: true }).click();
  await expect(table.getByRole("columnheader", { name: /Text/ })).toHaveAttribute(
    "aria-sort", "ascending",
  );
  await expect(table.getByRole("columnheader", { name: /Page/ })).toHaveAttribute(
    "aria-sort", "ascending",
  );
  // Precedence is stated, because two arrows cannot say which column wins.
  await expect(table.getByRole("columnheader", { name: /Text/ })).toContainText("1");
  await expect(table.getByRole("columnheader", { name: /Page/ })).toContainText("2");
  await expect(query.getByTestId("query-sort-trigger")).toHaveAttribute("data-sorted", "true");
  await awaitSaved(page);

  // The panel is where precedence can be moved, and where it can be dropped.
  await query.getByTestId("query-sort-trigger").click();
  const panel = page.getByTestId("query-sort-panel");
  await panel.getByRole("button", { name: "Move Page earlier" }).click();
  await expect(table.getByRole("columnheader", { name: /Page/ })).toContainText("1");
  await awaitSaved(page);
  await page.keyboard.press("Escape");

  await page.reload();
  const reloaded = page.getByTestId("query-block");
  await expect(reloaded.getByRole("columnheader", { name: /Page/ })).toContainText("1");
  await expect(reloaded.getByRole("columnheader", { name: /Text/ })).toContainText("2");
});
