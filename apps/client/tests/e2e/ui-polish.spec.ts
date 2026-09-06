import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  createGraph,
  createPage,
  mutateAndAwaitSaved,
  openPageProperties,
  savedSequence,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

test("toolbar history includes the latest block draft and restores it with redo", async ({
  page,
}) => {
  await createGraph(page, "Toolbar history");
  await createPage(page, "Writing");
  await startOutline(page);
  await typeInFocusedBlock(page, "Before");

  const editor = page.getByLabel("Block text");
  const before = await savedSequence(page);
  await editor.fill("After");
  // Click immediately after input: toolbar history must include the editor's
  // pending draft without requiring a debounce or an explicit save gesture.
  await page.getByTestId("topbar-undo").click();
  await awaitSaved(page, before);
  await expect(editor).toHaveValue("Before");
  await expect(page.getByTestId("outline-row")).toHaveCount(1);

  await mutateAndAwaitSaved(page, () => page.getByTestId("topbar-redo").click());
  await expect(editor).toHaveValue("After");
  await page.reload();
  await expect(page.getByLabel("Block text")).toHaveValue("After");
});

test("Add property creates a visible page query that can be removed", async ({ page }) => {
  await createGraph(page, "Page query");
  await createPage(page, "Query host");
  await startOutline(page);
  await typeInFocusedBlock(page, "A visible result");

  await openPageProperties(page);
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill("query");
  await mutateAndAwaitSaved(page, () =>
    picker.getByRole("option", { name: "Query", exact: true }).click(),
  );
  await expect(picker).toHaveCount(0);
  const query = page.getByTestId("query-block");
  await expect(query).toBeVisible();
  await expect(query.getByTestId("query-table")).toContainText("A visible result");
  await expect(query.getByTestId("query-conditions-trigger")).toBeVisible();

  await page.reload();
  await expect(query).toBeVisible();
  await query.getByTestId("query-actions-trigger").click();
  await mutateAndAwaitSaved(page, () =>
    page.getByRole("menuitem", { name: "Remove query", exact: true }).click(),
  );
  await expect(query).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("page-title")).toHaveValue("Query host");
  await expect(query).toHaveCount(0);
});

test("page linked references open and highlight the source block", async ({ page }) => {
  await createGraph(page, "Linked references");
  await createPage(page, "Destination");
  const destination = page.url();
  await createPage(page, "Source");
  const source = page.url();
  await startOutline(page);
  await page.keyboard.type("Read [[Destination");
  await mutateAndAwaitSaved(page, () =>
    page
      .getByTestId("page-reference-menu")
      .getByRole("option", { name: "Destination", exact: true })
      .click(),
  );
  await page.goto(destination);

  const reference = page.getByTestId("linked-reference");
  await expect(reference).toContainText("Source");
  await expect(reference).toContainText("Read");
  await reference.getByRole("button", { name: "Open block", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByTestId("outline-row")).toHaveAttribute(
    "data-navigation-highlight",
    "true",
  );
  await expect(page.getByTestId("outline-row")).toContainText("Destination");
});
