import { test, expect } from "../support/fixtures";

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
