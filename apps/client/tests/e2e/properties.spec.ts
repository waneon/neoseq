import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  createGraph,
  createPage,
  openBlockProperties,
  openBlockTags,
  openPageMenu,
  openPageProperties,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function addCustom(
  page: Page,
  key: string,
  type: "string" | "number" | "checkbox" | "date" | "page",
  value: string,
): Promise<void> {
  await openPageProperties(page);
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill(key);
  await picker.getByRole("option", { name: `Create property “${key}”` }).click();
  await picker.getByRole("option", { name: type, exact: true }).click();
  if (type === "checkbox") {
    await picker.getByRole("option", { name: value === "yes" ? "Checked" : "Unchecked", exact: true }).click();
  } else if (type === "page") {
    await picker.getByTestId("page-autocomplete").fill(value);
    await page.getByRole("option", { name: "Everything", exact: true }).click();
  } else {
    await picker.getByLabel(`${key} value`).fill(value);
    await picker.getByTestId("property-set").click();
  }
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);
}

test("edits every value type plus unknown keys in the contextual picker", async ({ page }) => {
  await createGraph(page, "Props Graph");
  await createPage(page, "Everything");

  await addCustom(page, "user.text", "string", "hello");
  await addCustom(page, "user.count", "number", "42");
  await addCustom(page, "user.done", "checkbox", "yes");
  await addCustom(page, "user.when", "date", "2026-08-03");
  await addCustom(page, "user.ref", "page", "Every");

  await page.getByTestId("prop-user.text").click();
  let picker = page.getByTestId("property-picker");
  await picker.getByLabel("user.text value").fill("updated");
  await picker.getByTestId("property-set").click();
  await awaitSaved(page);
  await page.reload();
  await expect(page.getByTestId("prop-user.text")).toContainText("updated");
  await page.getByRole("button", { name: "+1 more" }).click();
  picker = page.getByTestId("property-picker");

  // The compact strip deliberately exposes only four entries and storage does
  // not promise insertion order. Verify persisted values through the canonical
  // picker, which lists every existing property first.
  await picker.getByRole("option", { name: /user\.count/ }).click();
  await expect(picker).toContainText("42");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /user\.done/ }).click();
  await expect(picker).toContainText("Checked");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /user\.when/ }).click();
  await expect(picker).toContainText("2026-08-03");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /user\.ref/ }).click();
  await expect(picker).toContainText("Everything");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /user\.count/ }).click();
  await picker.getByRole("button", { name: "Clear property" }).click();
  await openPageProperties(page);
  await page.getByTestId("property-picker").getByLabel("Property key").fill("user.count");
  await expect(page.getByRole("option", { name: "Create property “user.count”" })).toBeVisible();
});

test("rejects property keys outside the owned namespaces with a visible validation error", async ({ page }) => {
  await createGraph(page, "Validation Graph");
  await createPage(page, "Rules");
  await openPageProperties(page);
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill("tag");
  await expect(picker.getByTestId("props-error")).toContainText(
    "must use builtin.* or user.*",
  );
});

test("slash, block properties, and tags share the same focused target", async ({ page }) => {
  await createGraph(page, "Tag Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await page.getByLabel("Block text").pressSequentially("/pro");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");

  let picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "builtin.task-status", exact: true }).click();
  await picker.getByRole("option", { name: "doing", exact: true }).click();
  await expect(page.getByTestId("prop-builtin.task-status")).toContainText("doing");
  await expect(page.getByLabel("Block text")).toHaveValue("");

  await openBlockTags(page);
  let tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Project");
  await page.getByRole("option", { name: "Create tag “Project”" }).click();
  await expect(tags.getByTestId("tag-chip")).toContainText("#Project");
  await page.keyboard.press("Escape");
  await expect(tags).toHaveCount(0);

  const text = page.getByLabel("Block text").first();
  await text.click();
  await text.press("End");
  await text.press("Enter");
  await typeInFocusedBlock(page, "fresh block");
  await openBlockTags(page, 1);
  tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Proj");
  await page.getByRole("option", { name: "Project", exact: true }).click();
  await expect(tags.getByTestId("tag-chip")).toContainText("#Project");
  await tags.getByRole("button", { name: "Remove tag Project" }).click();
  await expect(tags.getByTestId("tag-chip")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(tags).toHaveCount(0);
  await openBlockProperties(page, 1);
  picker = page.getByTestId("property-picker");
  await expect(picker.getByLabel("Property key")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await page.getByLabel("Block text").nth(1).click();
  await page.keyboard.press("ControlOrMeta+P");
  picker = page.getByTestId("property-picker");
  await expect(picker.getByLabel("Property key")).toBeFocused();
});

test("deleted page references resolve to a tombstone, not a new page", async ({ page }) => {
  await createGraph(page, "Tombstone Graph");
  await createPage(page, "Ephemeral");
  await startOutline(page);
  await typeInFocusedBlock(page, "content to restore");

  await openPageMenu(page);
  await page.getByTestId("delete-page").click();
  await page.getByTestId("confirm-delete-page").click();
  await expect(page.getByTestId("tombstone")).toBeVisible();
  await expect(page.getByTestId("page-list").getByRole("link", { name: "Ephemeral" }))
    .toHaveCount(0);

  await page.getByTestId("restore-page").click();
  await expect(page.getByTestId("page-title")).toHaveValue("Ephemeral");
  await expect(page.locator('[data-testid="outline-row"] textarea').first()).toHaveValue(
    "content to restore",
  );
});
