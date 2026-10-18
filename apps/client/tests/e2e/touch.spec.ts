// Touch journeys run on an emulated phone with a stand-in software keyboard
// (support/keyboard): the keyboard follows text focus, and every surface has to
// follow the keyboard.

import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { KEYBOARD_HEIGHT, keyboardOpen, simulateSoftKeyboard } from "../support/keyboard";

async function bottomOf(locator: Locator): Promise<number> {
  const box = (await locator.boundingBox())!;
  return box.y + box.height;
}

/** Holds a finger on `target` until `until` shows, as a long press does. */
async function longPress(page: Page, target: Locator, until: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await expect(until).toBeVisible();
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.beforeEach(async ({ page }) => {
  await simulateSoftKeyboard(page);
});

test("block actions open as a sheet on the visible bottom edge and leave the keyboard down", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch sheets");
  await app.startBlock("First");
  await app.appendBlock("Second");
  await page.keyboard.press("Escape");
  await app.editors.first().tap();
  await expect.poll(() => keyboardOpen(page)).toBe(true);
  const height = page.viewportSize()!.height;
  const toolbar = page.getByTestId("mobile-editor-toolbar");
  // The writing tools ride on the keyboard.
  await expect.poll(() => bottomOf(toolbar)).toBeCloseTo(height - KEYBOARD_HEIGHT, 0);

  await toolbar.getByRole("button", { name: "Block actions", exact: true }).tap();
  const sheet = page.locator(".menu-surface.sheet");
  await expect(sheet.getByRole("menu", { name: "Block actions" })).toBeVisible();
  // The menu took focus, so the keyboard went down, and the sheet went with it
  // to the bottom of the screen rather than staying where the toolbar was.
  await expect.poll(() => keyboardOpen(page)).toBe(false);
  await expect.poll(() => bottomOf(sheet)).toBeCloseTo(height, 0);
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(page.viewportSize()!.width);

  await app.saved(() => sheet.getByRole("menuitem", { name: /^Move down/ }).tap());
  await app.expectOutline(["Second", "First"]);
  // Nothing raises the keyboard again for an edit the reader left.
  await expect(toolbar).toHaveCount(0);
  expect(await keyboardOpen(page)).toBe(false);
});

test("a picker sheet waits for a tap to type and then rises with the keyboard", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch picker");
  await app.startBlock("A task");
  await page.keyboard.press("Escape");
  await app.editors.first().tap();
  await page
    .getByTestId("mobile-editor-toolbar")
    .getByRole("button", { name: "Block actions", exact: true })
    .tap();
  await page.getByTestId("menu-properties").tap();
  const picker = page.getByTestId("property-picker");
  await expect(picker).toBeVisible();
  const search = picker.getByRole("combobox").or(picker.getByRole("searchbox")).first();
  await expect(search).not.toBeFocused();
  expect(await keyboardOpen(page)).toBe(false);
  const height = page.viewportSize()!.height;
  await expect.poll(() => bottomOf(picker)).toBeCloseTo(height, 0);

  await search.tap();
  await expect.poll(() => keyboardOpen(page)).toBe(true);
  await expect.poll(() => bottomOf(picker)).toBeCloseTo(height - KEYBOARD_HEIGHT, 0);
  expect((await picker.boundingBox())!.y).toBeGreaterThanOrEqual(0);

  // Choosing closes the sheet and the edit with it; the keyboard stays down.
  await picker.getByRole("option", { name: "Status", exact: true }).tap();
  await app.saved(() => picker.getByRole("option", { name: "To-do", exact: true }).tap());
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("mobile-editor-toolbar")).toHaveCount(0);
  await expect.poll(() => keyboardOpen(page)).toBe(false);
});

test("adding a child from a row's menu starts writing in it", async ({ app, page }) => {
  await app.createGraph("Touch child");
  await app.startBlock("Parent");
  await page.keyboard.press("Escape");
  await app.block(0).getByTestId("mobile-block-handle").tap();
  await app.saved(() => page.getByRole("menuitem", { name: /^Add child block/ }).tap());
  await expect(app.rows).toHaveCount(2);
  await expect(app.editors.nth(1)).toBeFocused();
  await expect.poll(() => keyboardOpen(page)).toBe(true);
  await expect(page.getByTestId("mobile-editor-toolbar")).toBeVisible();
});

test("deleting from a row's menu does not start writing in the row above", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch delete");
  await app.startBlock("Keep");
  await app.appendBlock("Remove");
  await page.keyboard.press("Escape");
  await app.block(1).getByTestId("mobile-block-handle").tap();
  await app.saved(() => page.getByRole("menuitem", { name: /^Delete block/ }).tap());
  await app.expectOutline(["Keep"]);
  await expect(page.getByTestId("mobile-editor-toolbar")).toHaveCount(0);
  expect(await keyboardOpen(page)).toBe(false);
});

test("a tap under the writing puts the keyboard away instead of adding a block", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch append");
  await app.startBlock("Only line");
  await page.keyboard.press("Escape");
  await app.editors.first().tap();
  await expect.poll(() => keyboardOpen(page)).toBe(true);
  await page.getByTestId("outline-append").tap();
  await expect.poll(() => keyboardOpen(page)).toBe(false);
  await app.settled();
  await expect(app.rows).toHaveCount(1);

  // With the keyboard down, the same tap is the way to add a line.
  await app.saved(() => page.getByTestId("outline-append").tap());
  await expect(app.rows).toHaveCount(2);
});

test("a long press opens a parent row's menu, where a tap folds it", async ({ app, page }) => {
  await app.createGraph("Touch parents");
  await app.startBlock("Parent");
  await app.appendBlock("Child");
  await app.editors.nth(1).tap();
  await app.saved(() =>
    page
      .getByTestId("mobile-editor-toolbar")
      .getByRole("button", { name: "Indent", exact: true })
      .tap(),
  );
  await page
    .getByTestId("mobile-editor-toolbar")
    .getByRole("button", { name: "Done", exact: true })
    .tap();
  const handle = app.block(0).getByTestId("mobile-block-handle");
  await longPress(page, handle, page.getByRole("menu", { name: "Block actions" }));
  // A sheet is dismissed by a tap above it.
  await page.touchscreen.tap(page.viewportSize()!.width / 2, 24);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(app.rows).toHaveCount(2);
  await handle.tap();
  await expect(app.rows).toHaveCount(1);
});

test("every field a touch screen focuses is at least body size", async ({ app, page }) => {
  const fontSize = () =>
    page.evaluate(() => parseFloat(getComputedStyle(document.activeElement!).fontSize));
  await app.createGraph("Touch fields");
  await app.startBlock("Writing");
  expect(await fontSize()).toBeGreaterThanOrEqual(16);
  await page.keyboard.press("Escape");
  await app.editors.first().tap();
  await page
    .getByTestId("mobile-editor-toolbar")
    .getByRole("button", { name: "Block actions", exact: true })
    .tap();
  await page.getByTestId("menu-properties").tap();
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("combobox").or(picker.getByRole("searchbox")).first().tap();
  expect(await fontSize()).toBeGreaterThanOrEqual(16);
  await page.keyboard.press("Escape");
  await page.getByTestId("mobile-search").tap();
  await expect(page.getByTestId("command-input")).toBeFocused();
  expect(await fontSize()).toBeGreaterThanOrEqual(16);
});

test("a phone table keeps each column readable and scrolls sideways past the screen", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch table");
  await app.startBlock("");
  const editor = app.editors.first();
  await editor.tap();
  await editor.pressSequentially("/quer");
  await app.saved(() =>
    page
      .getByTestId("slash-menu")
      .getByRole("option", { name: /^Query/ })
      .tap(),
  );
  const table = page.getByTestId("query-table");
  await expect(table).toBeVisible();
  const layout = () =>
    table.evaluate((wrap) => ({
      columns: [...wrap.querySelectorAll("col")].map((col) => col.getBoundingClientRect().width),
      overflow: wrap.scrollWidth - wrap.clientWidth,
    }));
  // A new query's text and page share a phone's width.
  await expect.poll(async () => (await layout()).overflow).toBeLessThanOrEqual(0);

  // On a narrower phone they keep their widths, and the table scrolls.
  await page.setViewportSize({ width: 340, height: 720 });
  await expect.poll(async () => (await layout()).overflow).toBeGreaterThan(0);
  const { columns } = await layout();
  expect(columns[0]).toBeGreaterThanOrEqual(184);
  expect(columns[1]).toBeGreaterThanOrEqual(144);
});

test.describe("held sideways", () => {
  test.use({ viewport: { width: 915, height: 412 } });

  test("a landscape phone keeps the touch handle and writing tools", async ({ app, page }) => {
    await app.createGraph("Touch landscape");
    await app.startBlock("Wide line");
    await app.editors.first().tap();
    await expect(page.getByTestId("mobile-editor-toolbar")).toBeVisible();
    await page
      .getByTestId("mobile-editor-toolbar")
      .getByRole("button", { name: "Done", exact: true })
      .tap();
    const handle = app.block(0).getByTestId("mobile-block-handle");
    await expect(handle).toBeVisible();
    await handle.tap();
    await expect(page.locator(".menu-surface.sheet")).toBeVisible();
  });
});
