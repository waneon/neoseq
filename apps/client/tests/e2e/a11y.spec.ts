import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  createGraph,
  openBlockMenu,
  openSettings,
  openSidebar,
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
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Query/ }).click();

  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-builder")).toBeVisible();
  await query.getByTestId("qb-add-condition").click();
  await expect(query.getByTestId("qb-condition")).toBeVisible();
  await expect(query.getByTestId("query-table")).toBeVisible();
  expect(await audit(page)).toEqual([]);

  // The columns panel is a floating surface with a filter and a list of
  // switches, which is three things an audit should see over a live table.
  await query.getByTestId("query-columns-trigger").click();
  await expect(page.getByTestId("query-columns-panel")).toBeVisible();
  expect(await audit(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await query.getByTestId("query-view-trigger").click();
  await page.getByRole("menuitemradio", { name: "List", exact: true }).click();
  await expect(query.getByTestId("query-list")).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

// The tags screen is the product's one manager: grouped rows, each with three
// controls in it, and a panel of swatches and an emoji grid over the top.
test("the tags directory and its identity panel pass the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Tag Manager");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  for (const name of ["Design", "Reading"]) {
    await page.getByTestId("new-tag").click();
    await page.getByTestId("new-tag-name").fill(name);
    await page.getByTestId("new-tag-name").press("Enter");
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tag-row")).toHaveCount(2);
  expect(await audit(page)).toEqual([]);

  await page.getByTestId("tag-mark").first().click();
  const panel = page.getByTestId("tag-identity");
  await expect(panel).toBeVisible();
  await panel.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  expect(await audit(page)).toEqual([]);

  // …and grouped, which is the shape the screen is actually read in.
  await panel.getByTestId("tag-group-field").fill("Areas");
  await panel.getByTestId("tag-group-field").press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tag-group-name")).toHaveText(["Areas", "Ungrouped"]);
  expect(await audit(page)).toEqual([]);
});

// A tag's page is the query surface at its largest: a tab strip of saved views,
// a caption, and a result — the one place in the product with a `tablist` in it.
test("a tag's page and its view tabs pass the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Tag Page");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Reading");
  await page.getByTestId("new-tag-name").press("Enter");
  await page.getByTestId("tag-row-link").click();

  const query = page.getByTestId("query-block");
  // One view, named for what it shows; a second is what a reader makes.
  await expect(query.getByRole("tab")).toHaveCount(1);
  expect(await audit(page)).toEqual([]);

  await query.getByTestId("query-view-add").click();
  await page.getByRole("menuitem", { name: "List", exact: true }).click();
  await expect(query.getByRole("tab")).toHaveCount(2);
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

// Every new fill in the product is a new contrast pair, and the tinted date chip
// is four of them at once — one per due tier — sitting on the canvas in both
// modes. § Contrast commits the figures; this is the gate that keeps them true.
test("a task's marks and its tinted moments pass the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Task Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "audited moment");

  await openBlockMenu(page);
  await page.getByTestId("menu-properties").click();
  let picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Priority", exact: true }).click();
  await picker.getByRole("option", { name: "Medium", exact: true }).click();
  await expect(picker).toHaveCount(0);

  // One block per tier would be four blocks; one block whose thresholds move is
  // the same four pairs with less to set up.
  await page.getByLabel("Block text").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" /dead");
  await page.getByTestId("slash-menu").getByRole("option", { name: "Deadline" }).click();
  picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: /^Today/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("task-chip-deadline")).toBeVisible();

  for (const tone of ["neutral", "info", "ok", "attention", "danger"]) {
    await page.evaluate((chosen) => {
      const raw = localStorage.getItem("neoseq.settings.v1");
      const settings = raw ? JSON.parse(raw) : {};
      settings.dueTiers = { ...(settings.dueTiers ?? {}), soonTone: chosen };
      localStorage.setItem("neoseq.settings.v1", JSON.stringify(settings));
      window.dispatchEvent(new StorageEvent("storage", { key: "neoseq.settings.v1" }));
    }, tone);
    await expect(page.getByTestId("task-chip-deadline")).toHaveAttribute("data-palette", tone);
    expect(await audit(page)).toEqual([]);
  }

  // And the settled states, whose mark is cut out of a filled disc.
  for (const status of ["Done", "Cancelled"]) {
    await openBlockMenu(page);
    await page.getByTestId("menu-properties").click();
    picker = page.getByTestId("property-picker");
    // A key that already holds a value reads its value back in the row, so the
    // name is a prefix rather than the whole label from the second pass on.
    await picker.getByRole("option", { name: /^Status/ }).click();
    await picker.getByRole("option", { name: status, exact: true }).click();
    await expect(picker).toHaveCount(0);
    expect(await audit(page)).toEqual([]);
  }
});

test("the task settings section passes the basic audit", async ({ page }) => {
  await createGraph(page, "A11y Task Settings");
  await openSettings(page, "tasks");
  await expect(page.getByTestId("settings-due-tiers")).toBeVisible();
  expect(await audit(page)).toEqual([]);
});

test("a journal's standing questions pass the basic audit, written and read", async ({ page }) => {
  await createGraph(page, "A11y Default Queries");
  await openSettings(page, "queries");
  // Two rows, one open: the collapsed head and the builder under it are the two
  // shapes this section has, and the audit should see both at once.
  await page.getByTestId("add-default-query").click();
  await page.getByTestId("add-default-query").click();
  await expect(page.getByTestId("query-builder")).toBeVisible();
  expect(await audit(page)).toEqual([]);

  // …and the columns panel, which is the one floating surface this section
  // summons and the only place a table's shape is chosen.
  await page.getByTestId("default-query-layout-table").click();
  await page.getByTestId("query-columns-trigger").click();
  await expect(page.getByTestId("query-columns-panel")).toBeVisible();
  expect(await audit(page)).toEqual([]);
  await page.keyboard.press("Escape");

  // And the answer under the day, where the caption is a caption and the only
  // verbs are the reader's.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("journal-queries")).toBeVisible();
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
