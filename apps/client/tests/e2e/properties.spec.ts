import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  createGraph,
  createPage,
  openBlockInspector,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function addProperty(
  page: Page,
  section: "page" | "defaults" | "block",
  key: string,
  type: string | null,
  fill: (page: Page) => Promise<void>,
): Promise<void> {
  const root = page.getByTestId(`props-${section}`);
  await root.getByLabel("New property key").fill(key);
  if (type) await root.getByLabel("New property type").selectOption(type);
  await fill(page);
  await root.getByTestId("props-add-submit").click();
  await expect(root.getByTestId(`prop-${key}`)).toBeVisible();
  await awaitSaved(page);
}

test("edits every value type plus unknown keys in the generic editor", async ({ page }) => {
  await createGraph(page, "Props Graph");
  await createPage(page, "Everything");
  const section = page.getByTestId("props-page");

  await addProperty(page, "page", "custom.text", "string", async () => {
    await section.getByLabel("New property value").fill("hello");
  });
  await addProperty(page, "page", "custom.count", "number", async () => {
    await section.getByLabel("New property value").fill("42");
  });
  await addProperty(page, "page", "custom.done", "checkbox", async () => {
    await section.getByLabel("New property value").check();
  });
  await addProperty(page, "page", "custom.when", "date", async () => {
    await section.getByLabel("New property value").fill("2026-08-03");
  });
  await addProperty(page, "page", "custom.ref", "page", async () => {
    await section.getByTestId("page-autocomplete").fill("Every");
    await page.getByRole("option", { name: "Everything" }).click();
  });

  // Unknown keys are labelled but fully editable.
  await expect(section.getByTestId("prop-custom.text")).toContainText("custom");
  await section.getByLabel("custom.text value").fill("updated");
  await section.getByLabel("custom.text value").press("Enter");
  await awaitSaved(page);
  await page.reload();
  await expect(page.getByTestId("props-page").getByLabel("custom.text value")).toHaveValue(
    "updated",
  );
  await expect(page.getByTestId("props-page").getByLabel("custom.count value")).toHaveValue("42");
  await expect(page.getByTestId("props-page").getByLabel("custom.done value")).toBeChecked();
  await expect(page.getByTestId("props-page").getByLabel("custom.when value")).toHaveValue(
    "2026-08-03",
  );
  await expect(page.getByTestId("props-page").getByTestId("prop-custom.ref")).toContainText(
    "Everything",
  );

  // Removal through the same generic row.
  await page.getByTestId("props-page").getByTestId("remove-custom.count").click();
  await expect(page.getByTestId("props-page").getByTestId("prop-custom.count")).toHaveCount(0);
});

test("rejects invalid defaults with a visible validation error", async ({ page }) => {
  await createGraph(page, "Validation Graph");
  await createPage(page, "Rules");
  const defaults = page.getByTestId("props-defaults");
  await defaults.getByLabel("New property key").fill("tag");
  await defaults.getByTestId("props-add-submit").click();
  await expect(defaults.getByTestId("props-error")).toContainText("cannot be a page default");
});

test("tag with page defaults copies missing keys but never overwrites", async ({ page }) => {
  await createGraph(page, "Tag Graph");

  await createPage(page, "Project");
  const defaults = page.getByTestId("props-defaults");
  await defaults.getByLabel("New property key").fill("task.status");
  await defaults.getByLabel("New property value").selectOption("todo");
  await defaults.getByTestId("props-add-submit").click();
  await expect(defaults.getByTestId("prop-task.status")).toBeVisible();
  await awaitSaved(page);

  // Journal block that already tracks its own status.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await typeInFocusedBlock(page, "tagged with existing status");
  await openBlockInspector(page);
  const inspector = page.getByTestId("block-inspector");
  await inspector.getByLabel("New property key").fill("task.status");
  await inspector.getByLabel("New property value").selectOption("doing");
  await inspector.getByTestId("props-add-submit").click();
  await expect(inspector.getByLabel("task.status value")).toHaveValue("doing");

  // Repeated tag via autocomplete: the default must not overwrite "doing".
  await inspector.getByTestId("page-autocomplete").fill("Proj");
  await page.getByRole("option", { name: "Project" }).click();
  await expect(inspector.getByTestId("tag-chip")).toContainText("#Project");
  await expect(inspector.getByLabel("task.status value")).toHaveValue("doing");

  // A second block without task.status receives the default copy.
  await inspector.getByLabel("Close block properties").click();
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, "fresh block");
  await openBlockInspector(page, 1);
  await page.getByTestId("block-inspector").getByTestId("page-autocomplete").fill("Proj");
  await page.getByRole("option", { name: "Project" }).click();
  await expect(
    page.getByTestId("block-inspector").getByLabel("task.status value"),
  ).toHaveValue("todo");

  // Removing the repeated tag keeps the copied ordinary property.
  await page
    .getByTestId("block-inspector")
    .getByRole("button", { name: "Remove tag Project" })
    .click();
  await expect(page.getByTestId("block-inspector").getByTestId("tag-chip")).toHaveCount(0);
  await expect(
    page.getByTestId("block-inspector").getByLabel("task.status value"),
  ).toHaveValue("todo");
});

test("deleted page references resolve to a tombstone, not a new page", async ({ page }) => {
  await createGraph(page, "Tombstone Graph");
  await createPage(page, "Ephemeral");
  await startOutline(page);
  await typeInFocusedBlock(page, "content to restore");

  await page.getByTestId("delete-page").click();
  await expect(page.getByTestId("tombstone")).toBeVisible();

  // The page is gone from the sidebar but the route stays resolvable.
  await expect(
    page.getByTestId("page-list").getByRole("link", { name: "Ephemeral" }),
  ).toHaveCount(0);

  await page.getByTestId("restore-page").click();
  await expect(page.getByTestId("page-title")).toHaveValue("Ephemeral");
  await expect(page.locator('[data-testid="outline-row"] textarea').first()).toHaveValue(
    "content to restore",
  );
});
