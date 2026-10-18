// Touch journeys run on an emulated phone with a stand-in software keyboard
// (support/keyboard): the keyboard follows text focus, and every surface has to
// follow the keyboard.

import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { FIXED_TIME, test } from "../support/fixtures";
import { NeoseqApp } from "../support/app";
import { KEYBOARD_HEIGHT, keyboardOpen, simulateSoftKeyboard } from "../support/keyboard";

async function bottomOf(locator: Locator): Promise<number> {
  const box = (await locator.boundingBox())!;
  return box.y + box.height;
}

/** Whether what a finger lands on across the sheet is the sheet, not something over it. */
async function expectOnTop(sheet: Locator): Promise<void> {
  await expect
    .poll(() =>
      sheet.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [0.2, 0.5, 0.8].every((x) =>
          [0.2, 0.5, 0.8].every((y) => {
            const hit = document.elementFromPoint(
              box.left + box.width * x,
              box.top + box.height * y,
            );
            return hit !== null && node.contains(hit);
          }),
        );
      }),
    )
    .toBe(true);
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

/** Every visible control's height, keyed by its place in the document. */
function heights(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const heights: Record<string, number> = {};
    const keyOf = (element: Element): string => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && node !== document.body;) {
        const parent: Element | null = node.parentElement;
        const id = node.getAttribute("data-testid");
        const name = node.tagName.toLowerCase() + (id ? `[${id}]` : `.${node.classList[0] ?? ""}`);
        // Counted among siblings of the same name, so an element only one
        // modality has (the touch handle) does not shift the others' keys.
        const current: Element = node;
        const index = parent
          ? [...parent.children]
              .filter(
                (sibling) =>
                  sibling.tagName === current.tagName &&
                  sibling.getAttribute("data-testid") === current.getAttribute("data-testid") &&
                  sibling.classList[0] === current.classList[0],
              )
              .indexOf(current)
          : 0;
        parts.unshift(`${name}:${index}`);
        node = parent;
      }
      return parts.join(">");
    };
    const controls =
      "button, a[href], [role=button], [role=tab], [role=option], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=switch], [role=combobox]";
    for (const element of document.body.querySelectorAll(controls)) {
      const box = element.getBoundingClientRect();
      if (box.height > 0 && getComputedStyle(element).visibility !== "hidden") {
        heights[keyOf(element)] = Math.round(box.height);
      }
    }
    return heights;
  });
}

/** The same graph on a mouse at the touch phone's size. */
async function mouseTwin(browser: Browser, baseURL: string, page: Page): Promise<Page> {
  const context = await browser.newContext({
    baseURL,
    viewport: page.viewportSize()!,
    hasTouch: false,
    isMobile: false,
  });
  const twin = await context.newPage();
  await twin.clock.setFixedTime(new Date(FIXED_TIME));
  return twin;
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
  await expectOnTop(sheet);
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
  await expectOnTop(picker);
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

test("a sheet holding a closed select is dimmed by nothing but the page behind it", async ({
  app,
  page,
}) => {
  await app.createGraph("Touch moment");
  await app.startBlock("Due soon");
  await page.keyboard.press("Escape");
  await app.block(0).getByTestId("mobile-block-handle").tap();
  await page.getByTestId("menu-properties").tap();
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Deadline", exact: true }).tap();
  // The moment editor holds a repeat-unit select that stays closed.
  await expect(picker.getByTestId("moment-picker")).toBeVisible();
  await expectOnTop(picker);
  await expect(page.locator(".sheet-scrim")).toHaveCount(1);

  await page.touchscreen.tap(page.viewportSize()!.width / 2, 24);
  await expect(picker).toHaveCount(0);
  await expect(page.locator(".sheet-scrim")).toHaveCount(0);
});

test("touch draws every control at the mouse's size; only list rows grow", async ({
  app,
  page,
  browser,
  baseURL,
}) => {
  const twin = await mouseTwin(browser, baseURL!, page);
  const build = async (graph: NeoseqApp, view: Page) => {
    await graph.createGraph("Touch twins");
    await graph.startBlock("Ship it");
    await graph.appendBlock("");
    const editor = graph.editors.last();
    await editor.click();
    await editor.pressSequentially("/quer");
    await graph.saved(() =>
      view
        .getByTestId("slash-menu")
        .getByRole("option", { name: /^Query/ })
        .click(),
    );
    await view.getByTestId("query-conditions-trigger").click();
    await graph.settled();
  };
  await build(app, page);
  await build(new NeoseqApp(twin), twin);
  const [touch, mouse] = await Promise.all([heights(page), heights(twin)]);
  // Rows a finger presses whole, and the outline's touch gutter, are touch's
  // own; inputs are at least 16px on touch. Nothing else may grow.
  const own =
    /outline-row|outline-touch|outline-bullet|outline-toggle|row-grip|block-|textarea|input|menu-row|mobile-editor-toolbar/;
  const grown = Object.entries(touch).filter(
    ([key, height]) =>
      !own.test(key.slice(key.lastIndexOf(">") + 1)) && key in mouse && height > mouse[key] + 1,
  );
  expect(
    grown.map(
      ([key, height]) => `${key.split(">").slice(-2).join(">")}: ${mouse[key]} -> ${height}`,
    ),
  ).toEqual([]);
  await twin.context().close();
});

test("touch controls are drawn compact and reached at full size", async ({ app, page }) => {
  await app.createGraph("Touch density");
  await app.startBlock("Due soon");
  await page.keyboard.press("Escape");
  await app.block(0).getByTestId("mobile-block-handle").tap();
  const rows = page.getByRole("menu", { name: "Block actions" }).getByRole("menuitem");
  // A list row is itself the target, so it is drawn at the target's height.
  for (const height of await rows.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().height),
  )) {
    expect(height).toBeGreaterThanOrEqual(44);
    expect(height).toBeLessThanOrEqual(45);
  }
  await page.getByTestId("menu-properties").tap();
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Deadline", exact: true }).tap();
  await expect(picker.getByTestId("moment-picker")).toBeVisible();

  // A control keeps the size it is drawn at with a mouse and still reaches 44px.
  const done = picker.getByRole("button", { name: "Done", exact: true });
  const reach = await done.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const middle = box.top + box.height / 2;
    const lands = (y: number) => node.contains(document.elementFromPoint(x, y));
    return { height: box.height, edges: lands(middle - 21) && lands(middle + 21) };
  });
  expect(reach.height).toBeLessThanOrEqual(32);
  expect(reach.edges).toBe(true);
  expect((await picker.getByTestId("moment-tab-date").boundingBox())!.height).toBeLessThanOrEqual(
    32,
  );
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
