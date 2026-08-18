import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  createGraph,
  openBlockMenu,
  openSettings,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function audit(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .flatMap((violation) =>
      violation.nodes.map(
        (node) => `${violation.id}: ${violation.help} (${node.target.join(" ")})`,
      ),
    );
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
  await openBlockMenu(page);
  await page.getByTestId("menu-properties").click();
  const picker = page.getByTestId("property-picker");
  await expect(picker).toBeVisible();
  await picker.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  expect(await audit(page)).toEqual([]);
});

// The query block is the densest control surface in the product — a sentence of
// dropdowns over a data table — so both of its faces are audited: the builder
// with a condition in it, and the result table with its header controls.
test("the query builder and its result table pass the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Query");
  await startOutline(page);
  await typeInFocusedBlock(page, "audited task");
  await page.getByLabel("Block text").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/query");
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Blocks/ }).click();

  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-builder")).toBeVisible();
  await query.getByTestId("qb-add-condition").click();
  await expect(query.getByTestId("qb-condition")).toBeVisible();
  await expect(query.getByTestId("query-table")).toBeVisible();
  expect(await audit(page)).toEqual([]);

  await query.getByTestId("query-view-trigger").click();
  await page.getByRole("menuitemradio", { name: "List", exact: true }).click();
  await expect(query.getByTestId("query-list")).toBeVisible();
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
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const appearanceTab = page.getByTestId("settings-tab-appearance");
  await appearanceTab.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  // Keyboard focus is component-owned (DESIGN.md § Interaction States): the
  // tab takes the product's one roving highlight — the wash plus the 2px
  // accent rule at the left edge — never a drawn outline, which would be
  // outside § Depth's three legal lines.
  await expect.poll(() => appearanceTab.evaluate((element) => {
    const styles = getComputedStyle(element);
    const rule = getComputedStyle(element, "::before");
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return (
      styles.outlineStyle === "none" &&
      rule.width === "2px" &&
      rule.backgroundColor === accent
    );
  })).toBe(true);
  expect(await audit(page)).toEqual([]);
});
