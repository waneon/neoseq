import { devices } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { inkBox, misalignedRows } from "../support/alignment";

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
  await builder.getByTestId("qb-add-condition").click();
  await app.saved(() => page.getByRole("option", { name: "Status", exact: true }).click());
  await page.keyboard.press("Escape");

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

test("settings header centers Close on the title and mirrors its edge", async ({ app, page }) => {
  await app.createGraph("Framed settings");
  await app.settings("journal");
  const surface = ".settings-dialog-surface";
  for (const size of [
    { width: 1280, height: 720 },
    { width: 650, height: 800 },
  ]) {
    await page.setViewportSize(size);
    const frame = (await page.locator(surface).boundingBox())!;
    const title = (await inkBox(page, `${surface} [data-slot="dialog-title"]`))!;
    const close = (await inkBox(page, `${surface} [data-slot="dialog-close"] svg`))!;
    const label = (await inkBox(page, `${surface} .settings-group h3`))!;
    expect(close.middle, `${size.width}px`).toBe(title.middle);
    expect(frame.x + frame.width - close.right, `${size.width}px`).toBe(title.left - frame.x);
    expect(label.left, `${size.width}px`).toBe(title.left);
  }
});

test.describe("on a phone", () => {
  const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
  test.use(phone);

  test("settings chrome meets the edges its content starts on", async ({ app, page }) => {
    await app.createGraph("Phone settings");
    await app.sidebar();
    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    const surface = ".settings-dialog-surface";
    // A full-screen sheet has no floating edge to ring.
    await expect(page.locator(surface)).toHaveCSS("box-shadow", "none");
    const title = await inkBox(page, `${surface} [data-slot="dialog-title"]`);
    const close = await inkBox(page, `${surface} [data-slot="dialog-close"] svg`);
    const card = await page.locator(`${surface} .settings-group-links`).first().boundingBox();
    const edges = { start: card!.x, end: card!.x + card!.width };
    expect(close!.middle).toBe(title!.middle);
    expect(close!.right).toBe(edges.end);
    expect(title!.left).toBe(edges.start);
    for (const label of await page.locator(`${surface} .settings-group h3`).all()) {
      expect((await label.boundingBox())!.x).toBe(edges.start);
    }
    // Inside a card, the chevron's strokes mirror the icon tile's inset.
    const tile = await page.locator(`${surface} .settings-tab-icon`).first().boundingBox();
    const chevron = await inkBox(page, `${surface} .settings-tab-chevron`);
    expect(edges.end - 1 - chevron!.right).toBe(tile!.x - edges.start - 1);

    await page.getByTestId("settings-tab-journal").click();
    await app.settled();
    // The page slides in; it is measured where it comes to rest.
    await expect
      .poll(() => inkBox(page, `${surface} .settings-page-header h2`))
      .toMatchObject({ left: edges.start });
    const back = await inkBox(page, `${surface} .settings-back svg`);
    expect(back!.left).toBe(edges.start);
    expect(back!.middle).toBe(close!.middle);
  });
});
