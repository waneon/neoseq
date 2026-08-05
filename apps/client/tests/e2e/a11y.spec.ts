import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createGraph, openSidebar, startOutline, typeInFocusedBlock } from "./helpers";

async function audit(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.help}`);
}

test("graph picker passes the basic accessibility audit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your graphs" })).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test("journal, outline, and property editors pass the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "audited block");
  await page.getByTestId("block-menu").click();
  await page.getByTestId("menu-properties").click();
  await expect(page.getByTestId("block-inspector")).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

// A toast is the one surface that arrives unbidden and floats over whatever the
// user was reading, so it is audited while it is actually up — in both colour
// schemes, like every other pair in the token set.
test("a raised toast passes the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Toast");
  await startOutline(page);
  await typeInFocusedBlock(page, "first");
  await page.getByLabel("Block text").first().click();
  await page.keyboard.press("Tab"); // rejected by the core: first sibling
  await expect(page.getByTestId("toast")).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test("settings passes the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Settings");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(await audit(page)).toEqual([]);
});
