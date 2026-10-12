import { test, expect } from "../support/fixtures";
import { misalignedRows } from "../support/alignment";

test("block metadata and mixed query values retain one vertical center", async ({ app, page }) => {
  await app.createGraph("Aligned writing");
  await app.createPage("Records");
  await app.startBlock("Initial writing");
  const record = app.block(0);

  await record.getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-tags").click();
  const tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Project");
  await app.saved(() => tags.getByRole("option", { name: /Create tag/ }).click());
  await page.keyboard.press("Escape");

  for (const writing of ["Aligned writing", "Wrapped writing and aligned metadata. ".repeat(7)]) {
    await app.editBlock(0, writing);
    await expect
      .poll(() =>
        record.evaluate((row) => {
          const content = row.querySelector<HTMLElement>(".block-line:not([hidden])")!;
          const tag = row.querySelector<HTMLElement>(".outline-tags .chip")!;
          const textBox = content.getBoundingClientRect();
          const tagBox = tag.getBoundingClientRect();
          return Math.abs(textBox.y + textBox.height / 2 - tagBox.y - tagBox.height / 2);
        }),
      )
      .toBeLessThanOrEqual(0.5);
  }

  await app.editBlock(0, "Aligned writing");
  await record.getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-properties").click();
  const properties = page.getByTestId("property-picker");
  await properties.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => properties.getByRole("option", { name: "To-do", exact: true }).click());

  await app.appendBlock("");
  await app.editors.last().pressSequentially("/quer");
  await app.saved(() =>
    page
      .getByTestId("slash-menu")
      .getByRole("option", { name: /^Query/ })
      .click(),
  );
  const query = page.getByTestId("query-block");
  const builder = query.getByTestId("query-builder");
  await app.saved(() => builder.getByTestId("qb-add-condition").click());
  await builder.getByRole("combobox", { name: "Field", exact: true }).click();
  await app.saved(() => page.getByRole("option", { name: "Status", exact: true }).click());

  await query.getByTestId("query-columns-trigger").click();
  const columns = page.getByTestId("query-columns-panel");
  for (const label of ["Page", "Tags", "Status"]) {
    const choice = columns.getByRole("checkbox", { name: label, exact: true });
    if (!(await choice.isChecked())) {
      await app.saved(() => choice.click());
      await expect(choice).toBeChecked();
    }
  }
  await page.keyboard.press("Escape");
  const row = query.getByTestId("query-row");
  await expect(row).toHaveCount(1);

  for (const compact of [false, true]) {
    if (compact) {
      await query.getByTestId("query-view-trigger").click();
      await app.saved(() => page.getByRole("menuitemcheckbox", { name: "Compact rows" }).click());
    }
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const center = box.y + box.height / 2;
          const values = element.querySelectorAll<HTMLElement>(
            ".query-result-input, .query-status, .query-link, .query-tag-chip",
          );
          return (
            values.length >= 4 &&
            [...values].every((value) => {
              const bounds = value.getBoundingClientRect();
              return Math.abs(bounds.y + bounds.height / 2 - center) <= 0.5;
            })
          );
        }),
      )
      .toBe(true);
  }
});

test("every single-line row centers its text and marks on one line", async ({ app, page }) => {
  const misaligned: string[] = [];
  const audit = async (surface: string) => {
    for (const row of await misalignedRows(page)) misaligned.push(`${surface} › ${row}`);
  };

  await app.createGraph("Centered rows");
  await page.getByRole("button", { name: "Previous day" }).click();
  await app.startBlock("Yesterday's thought");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await app.startBlock("Today's thought");
  await app.appendBlock("A nested idea");
  await app.editors.last().press("Tab");
  await app.settled();
  await audit("journal");

  await app.createPage("Plans");
  await app.startBlock("Write the abstract");
  await app.block(0).getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-tags").click();
  const tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Paper");
  await app.saved(() => tags.getByRole("option", { name: /Create tag/ }).click());
  await audit("tag picker");
  await page.keyboard.press("Escape");
  await app.block(0).getByTestId("block-bullet").click({ button: "right" });
  await audit("block menu");
  await page.getByTestId("menu-properties").click();
  await audit("property picker");
  const properties = page.getByTestId("property-picker");
  await properties.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => properties.getByRole("option", { name: "To-do", exact: true }).click());
  await audit("page");
  await page.getByTestId("page-actions-trigger").click();
  await audit("page menu");
  await page.keyboard.press("Escape");

  await page.getByTestId("open-palette").click();
  await page.getByTestId("command-input").fill("p");
  await audit("palette");
  await page.keyboard.press("Escape");

  await page.getByTestId("nav-pages").click();
  await audit("pages");
  await page.getByTestId("nav-tags").click();
  await audit("tags");
  await page.getByTestId("tag-row-link").first().click();
  await page.getByTestId("tag-defaults-toggle").click();
  await audit("tag");

  await page.getByTestId("open-settings").click();
  for (const section of ["appearance", "journal", "tasks", "keyboard", "graph"]) {
    await page.getByTestId(`settings-tab-${section}`).click();
    await audit(`settings ${section}`);
  }
  await page.keyboard.press("Escape");

  await page.goto("/");
  await expect(page.getByTestId("graph-list")).toBeVisible();
  await audit("library");

  expect(misaligned).toEqual([]);
});
