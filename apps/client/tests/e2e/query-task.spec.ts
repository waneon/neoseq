import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  createGraph,
  openBlockInspector,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

test("query-task projections share ordinary properties and the SPARQL index", async ({ page }) => {
  await createGraph(page, "Query Task Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Ship the query engine");

  await openBlockInspector(page);
  let inspector = page.getByTestId("block-inspector");
  await inspector.getByLabel("New property key").fill("task.status");
  await inspector.getByLabel("New property value").selectOption("todo");
  await inspector.getByTestId("props-add-submit").click();
  await inspector.getByLabel("Close block properties").click();

  const status = page.getByLabel("Task status");
  await expect(status).toHaveValue("todo");
  await status.selectOption("done");
  await awaitSaved(page);
  await openBlockInspector(page);
  inspector = page.getByTestId("block-inspector");
  await expect(inspector.getByLabel("task.status value")).toHaveValue("done");
  await inspector.getByLabel("Close block properties").click();

  const taskText = page.locator(".outline-input").first();
  await taskText.click();
  await taskText.press("End");
  await taskText.press("Enter");
  await typeInFocusedBlock(page, "Done tasks");
  await openBlockInspector(page, 1);
  inspector = page.getByTestId("block-inspector");
  await inspector.getByLabel("New property key").fill("query.source");
  await inspector.getByLabel("New property value").fill(
    "PREFIX neo: <urn:neoseq:vocab:v1:> PREFIX prop: <urn:neoseq:property:> SELECT ?content WHERE { ?block prop:task.status \"done\"; neo:content ?content }",
  );
  await inspector.getByTestId("props-add-submit").click();
  await expect(inspector.getByTestId("prop-query.language")).toContainText(
    "sparql-1.1/neoseq-v1",
  );
  await inspector.getByLabel("Close block properties").click();

  const query = page.getByTestId("query-block");
  await expect(query.getByLabel("SPARQL source")).toBeVisible();
  await expect(query).toContainText("Ship the query engine");
});
