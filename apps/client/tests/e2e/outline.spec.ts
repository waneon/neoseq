import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  blockLevels,
  blockTexts,
  createGraph,
  openBlockMenu,
  startOutline,
} from "./helpers";

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

  // Undo and redo are keyboard-and-palette verbs now; the top bar carries state,
  // not commands. The outline's textarea maps them to the *document* undo.
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual([
    "parent",
    "child",
    "grandchild",
    "second root",
  ]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
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

test("undo and redo reconcile text in the focused block", async ({ page }) => {
  await createGraph(page, "Text History Graph");
  await startOutline(page);

  const textarea = page.locator('[data-testid="outline-row"] textarea').first();
  await page.keyboard.type("alpha");
  await awaitSaved(page);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(textarea).toHaveValue("");

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(textarea).toHaveValue("alpha");
});

test("the bullet carries the block's menu, and every structural verb in it", async ({
  page,
}) => {
  await createGraph(page, "Menu Graph");
  await startOutline(page);
  await page.keyboard.type("first");
  await page.locator('[data-testid="outline-row"] textarea').first().blur();

  await openBlockMenu(page, 0);
  await page.getByRole("menuitem", { name: "Add child block" }).click();
  await page.keyboard.type("child via menu");
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2"]);

  await openBlockMenu(page, 1);
  await page.getByRole("menuitem", { name: "Outdent" }).click();
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1"]);

  await openBlockMenu(page, 1);
  await page.getByTestId("menu-move-up").click();
  await expect.poll(() => blockTexts(page)).toEqual(["child via menu", "first"]);

  await openBlockMenu(page, 0);
  await page.getByTestId("menu-delete").click();
  await expect.poll(() => blockTexts(page)).toEqual(["first"]);
});

test("drags a range of blocks out and moves them as one", async ({ page }) => {
  await createGraph(page, "Selection Graph");
  await startOutline(page);
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("three");
  await expect.poll(() => blockTexts(page)).toEqual(["one", "two", "three"]);
  await awaitSaved(page);

  // The strip left of the bullets is the selection gutter: drag down it and the
  // rows it passes are selected.
  const rows = page.locator('[data-testid="outline-row"]');
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  if (!first || !second) throw new Error("outline rows have no layout");
  await page.mouse.move(first.x + 4, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-selected", "false");

  // Dragging any selected bullet past the last row moves the whole selection.
  const handle = await page.getByTestId("block-bullet").nth(0).boundingBox();
  const last = await rows.nth(2).boundingBox();
  if (!handle || !last) throw new Error("drag targets have no layout");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, last.y + last.height - 2, { steps: 8 });
  await expect(page.getByTestId("outline-drop")).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => blockTexts(page)).toEqual(["three", "one", "two"]);

  // And Backspace on the still-selected pair takes both.
  await page.keyboard.press("Backspace");
  await expect.poll(() => blockTexts(page)).toEqual(["three"]);
});
