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
  "builtin.query": "Query",
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

  const taskText = page.locator(".outline-input").first();
  await taskText.click();
  await taskText.press("End");
  await taskText.press("Enter");
  await typeInFocusedBlock(page, "Done tasks");
  await openBlockProperties(page, 1);
  await setKnownProperty(
    page,
    "builtin.query",
    "PREFIX neo: <urn:neoseq:vocab:v1:> PREFIX prop: <urn:neoseq:property:> SELECT ?content WHERE { ?block prop:builtin.task-status \"done\"; neo:content ?content }",
  );
  const query = page.getByTestId("query-block");
  await expect(query.getByLabel("SPARQL source")).toBeVisible();
  await expect(query).toContainText("Ship the query engine");
  await expect(query.getByTestId("query-view-trigger")).toContainText("Table");
  await chooseFromMenu(page, query.getByTestId("query-view-trigger"), "List");
  await expect(query.getByTestId("query-list")).toBeVisible();
});
