import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  chooseFromMenu,
  createGraph,
  openBlockProperties,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function setKnownProperty(page: Page, key: string, value: string): Promise<void> {
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill(key);
  await picker.getByRole("option", { name: key, exact: true }).click();
  if (key === "builtin.task-status") {
    await picker.getByRole("option", { name: value, exact: true }).click();
  } else {
    await picker.getByLabel(`${key} value`).fill(value);
    await picker.getByTestId("property-set").click();
  }
  await expect(picker).toHaveCount(0);
}

test("query-task projections share ordinary properties and the SPARQL index", async ({ page }) => {
  await createGraph(page, "Query Task Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Ship the query engine");

  await openBlockProperties(page);
  await setKnownProperty(page, "builtin.task-status", "todo");

  const status = page.getByLabel("Task status");
  await expect(status).toContainText("todo");
  await chooseFromMenu(page, status, "done");
  await awaitSaved(page);
  await expect(page.getByTestId("prop-builtin.task-status")).toContainText("done");

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
  await expect(page.getByTestId("prop-builtin.query")).toContainText("sparql-1.1/neoseq-v1");

  const query = page.getByTestId("query-block");
  await expect(query.getByLabel("SPARQL source")).toBeVisible();
  await expect(query).toContainText("Ship the query engine");
});
