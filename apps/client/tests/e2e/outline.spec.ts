import { expect, test } from "@playwright/test";
import { blockLevels, blockTexts, createGraph, startOutline } from "./helpers";

test("builds a deep outline with the keyboard and reorders a subtree", async ({ page }) => {
  await createGraph(page, "Outline Graph");
  await startOutline(page);

  // parent / child / grandchild / second-root via Enter+Tab / Shift+Tab.
  await page.keyboard.type("parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("child");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("grandchild");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("second root");

  await expect.poll(() => blockTexts(page)).toEqual([
    "parent",
    "child",
    "grandchild",
    "second root",
  ]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2", "3", "1"]);

  // Keyboard traversal across the deep outline.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator('[data-testid="outline-row"] textarea').nth(1)).toBeFocused();

  // Subtree reorder: move "second root" above "parent"; its children follow.
  const secondRoot = page.locator('[data-testid="outline-row"] textarea').nth(3);
  await secondRoot.click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => blockTexts(page)).toEqual([
    "second root",
    "parent",
    "child",
    "grandchild",
  ]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1", "2", "3"]);

  // Collapse hides the subtree without touching canonical state.
  await page.locator('[data-testid="outline-row"]').nth(1).getByLabel("Collapse").click();
  await expect.poll(() => blockTexts(page)).toEqual(["second root", "parent"]);
  await page.locator('[data-testid="outline-row"]').nth(1).getByLabel("Expand").click();
  await expect.poll(() => blockTexts(page)).toEqual([
    "second root",
    "parent",
    "child",
    "grandchild",
  ]);

  // Undo/redo through the shell controls.
  await page.getByTestId("undo").click();
  await expect.poll(() => blockTexts(page)).toEqual([
    "parent",
    "child",
    "grandchild",
    "second root",
  ]);
  await page.getByTestId("redo").click();
  await expect.poll(() => blockTexts(page)).toEqual([
    "second root",
    "parent",
    "child",
    "grandchild",
  ]);
});

test("splits a block at the caret and deletes empty blocks", async ({ page }) => {
  await createGraph(page, "Split Graph");
  await startOutline(page);
  await page.keyboard.type("headtail");
  const textarea = page.locator('[data-testid="outline-row"] textarea').first();
  await textarea.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(4, 4);
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => blockTexts(page)).toEqual(["head", "tail"]);

  // Backspace on an emptied block removes it and refocuses the previous one.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect.poll(() => blockTexts(page)).toEqual(["head", ""]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => blockTexts(page)).toEqual(["head"]);
  await expect(page.locator('[data-testid="outline-row"] textarea').first()).toBeFocused();
});

test("touch-style block menu supports structural commands", async ({ page }) => {
  await createGraph(page, "Menu Graph");
  await startOutline(page);
  await page.keyboard.type("first");
  await page.locator('[data-testid="outline-row"] textarea').first().blur();

  await page.getByTestId("block-menu").click();
  await page.getByRole("menuitem", { name: "Add child block" }).click();
  await page.keyboard.type("child via menu");
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2"]);

  await page.getByTestId("block-menu").nth(1).click();
  await page.getByRole("menuitem", { name: "Outdent" }).click();
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1"]);

  await page.getByTestId("block-menu").nth(1).click();
  await page.getByTestId("menu-move-up").click();
  await expect.poll(() => blockTexts(page)).toEqual(["child via menu", "first"]);

  await page.getByTestId("block-menu").nth(0).click();
  await page.getByTestId("menu-delete").click();
  await expect.poll(() => blockTexts(page)).toEqual(["first"]);
});
