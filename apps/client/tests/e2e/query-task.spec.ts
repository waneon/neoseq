import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  chooseFromMenu,
  createGraph,
  insertQueryBlock,
  mutateAndAwaitSaved,
  openBlockProperties,
  savedSequence,
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
  await page.getByTestId("query-builder").getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("query-task projections share ordinary properties and the SPARQL index", async ({ page }) => {
  await createGraph(page, "Query Task Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Ship the query engine");

  // Make the query while the outline is the only active surface. Property and
  // dropdown focus restoration below must not overlap the slash command that is
  // the query's sole creation route.
  const taskText = page.locator(".outline-input").first();
  await taskText.click();
  await taskText.press("End");
  await taskText.press("Enter");
  const query = page.getByTestId("query-block");
  await insertQueryBlock(
    page,
    page.getByLabel("Block text").last(),
    query.getByTestId("query-builder"),
  );

  await openBlockProperties(page);
  await mutateAndAwaitSaved(page, () =>
    setKnownProperty(page, "builtin.task-status", "To-do"));

  const status = page.getByTestId("task-status-toggle");
  await expect(status).toHaveAccessibleName("Task status: To-do");
  await mutateAndAwaitSaved(page, () => chooseFromMenu(page, status, "Done"));
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
  await expect(page.getByTestId("property-picker")).toHaveCount(0);

  // Narrowing the plan narrows the SPARQL the core actually runs.
  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-add-condition").click());
  await mutateAndAwaitSaved(page, () => chooseInBuilder(page, "Field", "Status"));
  await mutateAndAwaitSaved(page, () => chooseInBuilder(page, "Value", "Done"));

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
  await mutateAndAwaitSaved(page, () => listEditor.press("Enter"));
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
  await mutateAndAwaitSaved(page, () =>
    page.getByRole("menuitem", { name: "Hide column" }).click());
  await page.reload();
  const reloaded = page.getByTestId("query-block");
  await expect(reloaded.getByTestId("query-table")).toBeVisible();
  await expect(reloaded.getByRole("columnheader", { name: /Page/ })).toHaveCount(0);

  // What a table shows is chosen on the table. One switch puts a column in the
  // query and in this view at once, and both halves survive a reload.
  await reloaded.getByTestId("query-columns-trigger").click();
  const beforeColumn = await savedSequence(page);
  await page.getByTestId("query-column-toggle-property:builtin.task-status").click();
  await page.keyboard.press("Escape");
  await expect(reloaded.getByRole("columnheader", { name: /Status/ })).toBeVisible();
  await awaitSaved(page, beforeColumn);
  await page.reload();
  await expect(
    page.getByTestId("query-block").getByRole("columnheader", { name: /Status/ }),
  ).toBeVisible();
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
  const query = page.getByTestId("query-block");
  const table = query.getByTestId("query-table");
  await insertQueryBlock(
    page,
    page.getByLabel("Block text").last(),
    table,
  );

  // One press orders by that column; the next adds a tie-breaker rather than
  // replacing the first choice.
  await mutateAndAwaitSaved(page, () =>
    table.getByRole("button", { name: "Text", exact: true }).click());
  await mutateAndAwaitSaved(page, () =>
    table.getByRole("button", { name: "Page", exact: true }).click());
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

  // The panel is where precedence can be moved, and where it can be dropped.
  await query.getByTestId("query-sort-trigger").click();
  const panel = page.getByTestId("query-sort-panel");
  await mutateAndAwaitSaved(page, () =>
    panel.getByRole("button", { name: "Move Page earlier" }).click());
  await expect(table.getByRole("columnheader", { name: /Page/ })).toContainText("1");
  await page.keyboard.press("Escape");

  await page.reload();
  const reloaded = page.getByTestId("query-block");
  await expect(reloaded.getByRole("columnheader", { name: /Page/ })).toContainText("1");
  await expect(reloaded.getByRole("columnheader", { name: /Text/ })).toContainText("2");
});

test("a result cell reads as the writing it quotes, centred on its row", async ({ page }) => {
  await createGraph(page, "Query Cell Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "a task worth quoting");
  const first = page.getByLabel("Block text").first();
  await first.click();
  await first.press("End");
  await first.press("Enter");
  const query = page.getByTestId("query-block");
  const table = query.getByTestId("query-table");
  await insertQueryBlock(
    page,
    page.getByLabel("Block text").last(),
    table,
  );

  const cell = table.locator("tbody td").first();
  const heading = table.locator("thead th").first();
  const block = page.getByLabel("Block text").first();

  const inks = await cell.evaluate((node) => {
    const table_ = node.closest("table");
    const th = table_.querySelector("thead th");
    const line = document.querySelector(".outline-text textarea");
    return {
      cell: getComputedStyle(node).color,
      align: getComputedStyle(node).verticalAlign,
      heading: getComputedStyle(th).color,
      block: getComputedStyle(line).color,
    };
  });
  // The values in a result *are* blocks, so they take the ink the outline gives
  // them; the heading stays the quieter of the two.
  expect(inks.cell).toBe(inks.block);
  expect(inks.heading).not.toBe(inks.cell);
  // A row is as tall as its tallest cell, and every other cell sits on its
  // centre line rather than hanging from its ceiling.
  expect(inks.align).toBe("middle");
  await expect(heading).toBeVisible();
  await expect(block).toBeVisible();

  // Whatever the cell's own content is, it is vertically centred in the cell:
  // a filled editable trigger claims the whole height, so the centring has to be
  // inside it rather than left to the cell.
  const centred = await cell.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const inner = node.querySelector("button, span");
    const content = inner.getBoundingClientRect();
    const top = content.top - box.top;
    const bottom = box.bottom - content.bottom;
    return Math.abs(top - bottom);
  });
  expect(centred).toBeLessThanOrEqual(1.5);

  // And so is the *line* inside that content, which is the half a centred box
  // does not cover: the writing surface is floored at the 24px hit target and
  // the line it holds is 20px, so a value with all four of those pixels below it
  // read two pixels above every link on the same row — every cell box centred,
  // and the table still without one baseline. A compact row is the same defect
  // with more of it: there the cell states its height, so the surface fills the
  // row and hung its line from the ceiling four pixels up.
  const lineOffsets = () => table.locator("tbody tr").first().evaluate((row) => {
    const box = row.getBoundingClientRect();
    const centre = box.top + box.height / 2;
    const lines: number[] = [];
    for (const cell of row.querySelectorAll("td")) {
      // A textarea's lines are not in the document, so they are counted rather
      // than measured: they start at the top of its content box, one
      // `line-height` each, and where the box is taller than they are the slack
      // is what this is about.
      const writing = cell.querySelector("textarea:not([hidden])");
      if (writing) {
        const area = writing.getBoundingClientRect();
        const style = getComputedStyle(writing);
        const inset = parseFloat(style.paddingTop);
        const leading = parseFloat(style.lineHeight);
        const content = area.height - inset - parseFloat(style.paddingBottom);
        const written = Math.max(1, Math.round(content / leading)) * leading;
        lines.push(area.top + inset + written / 2 - centre);
        continue;
      }
      // A rendered value states its own line through a range: the box around it
      // may claim the whole cell, and it is the ink that has to be on the centre.
      const value = cell.querySelector(".query-link, .query-markdown-preview");
      if (!value) continue;
      const range = document.createRange();
      range.selectNodeContents(value);
      const rects = [...range.getClientRects()];
      if (rects.length === 0) continue;
      const top = Math.min(...rects.map((rect) => rect.top));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      lines.push((top + bottom) / 2 - centre);
    }
    return lines;
  });
  // The written cell and the page it names, at least — one line each, both on the
  // row's centre.
  const roomy = await lineOffsets();
  expect(roomy.length).toBeGreaterThan(1);
  for (const offset of roomy) expect(Math.abs(offset)).toBeLessThanOrEqual(1);

  await query.getByTestId("query-view-trigger").click();
  await page.getByRole("menuitemcheckbox", { name: "Compact rows" }).click();
  await page.keyboard.press("Escape");
  await expect(table.locator("table")).toHaveAttribute("data-compact", "true");
  const compact = await lineOffsets();
  expect(compact.length).toBe(roomy.length);
  for (const offset of compact) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
});
