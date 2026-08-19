import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  blockLevels,
  blockTexts,
  createGraph,
  openBlockMenu,
  startOutline,
  typeInFocusedBlock,
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

test("leading Enter keeps block properties with the original identity and undoes once", async ({
  page,
}) => {
  await createGraph(page, "Leading Split Graph");
  await startOutline(page);
  await page.keyboard.type("alpha");
  await awaitSaved(page);

  await page.keyboard.press("ControlOrMeta+P");
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await picker.getByRole("option", { name: "Doing", exact: true }).click();
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing");
  await awaitSaved(page);

  const textarea = page.getByLabel("Block text");
  await textarea.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(0, 0);
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => blockTexts(page)).toEqual(["", "alpha"]);
  const rows = page.getByTestId("outline-row");
  await expect(rows.nth(0).getByTestId("task-status-toggle")).toHaveCount(0);
  await expect(rows.nth(1).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Doing",
  );
  await awaitSaved(page);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual(["alpha"]);
  await expect(rows.nth(0).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Doing",
  );
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

  // Dragging across a quiet row surface selects whole blocks. The already-active
  // third textarea still keeps native text selection; a different row starts a
  // structural range.
  const rows = page.locator('[data-testid="outline-row"]');
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  if (!first || !second) throw new Error("outline rows have no layout");
  await page.mouse.move(first.x + first.width * 0.7, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width * 0.7, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-selected", "false");
  await expect(rows.nth(0)).toHaveCSS("border-radius", "0px");

  await page.keyboard.press("Escape");

  // The blank page margin between the rail and the centered editor is the same
  // range handle, so selection does not depend on finding a narrow gutter.
  const body = await page.locator(".page-body").boundingBox();
  const scroll = await page.locator(".page-scroll").boundingBox();
  if (!body || !scroll) throw new Error("page surface has no layout");
  const marginX = Math.max(scroll.x + 4, body.x - 12);
  await page.mouse.move(marginX, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(marginX, second.y + second.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");

  const [copied] = await Promise.all([
    page.evaluate(() => new Promise<string>((resolve) => {
      document.addEventListener("copy", (event) => {
        resolve(event.clipboardData?.getData("text/plain") ?? "");
      }, { once: true });
    })),
    page.keyboard.press("ControlOrMeta+c"),
  ]);
  expect(copied).toBe("- one\n- two");

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

  // The selected deletion is one document-history item, irrespective of how
  // many independent subtree roots it contains.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual(["three", "one", "two"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => blockTexts(page)).toEqual(["three"]);
});

test("pastes Markdown list items as one outline history step", async ({ page }) => {
  await createGraph(page, "Clipboard Graph");
  await startOutline(page);

  await page.getByLabel("Block text").evaluate((target) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "- one\n  - two\n  - three\n- four");
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: clipboard,
    }));
  });

  await expect.poll(() => blockTexts(page)).toEqual(["one", "two", "three", "four"]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2", "2", "1"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual([""]);
});

test("pressing a block taller than the viewport does not move the page", async ({ page }) => {
  await createGraph(page, "Tall Block Graph");
  await startOutline(page);

  // A block long enough to outgrow the window on its own — which is what a block
  // carrying a query result does routinely.
  const long = Array.from({ length: 300 }, (_, index) => `sentence number ${index}`).join(" ");
  await page.getByLabel("Block text").fill(long);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, "the block after it");

  const tall = page.getByTestId("outline-row").first();
  const box = (await tall.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.height).toBeGreaterThan(viewport.height);

  // Park the page so the row overflows both edges of the window: on screen, and
  // impossible to align to either one.
  await page.evaluate(() => {
    document.querySelector(".page-scroll")!.scrollTop = 400;
  });
  const before = await page.evaluate(() => document.querySelector(".page-scroll")!.scrollTop);

  // "Keep the focused row visible" is right for a row that arrived from the
  // keyboard and wrong for one the pointer just pressed: a row taller than the
  // viewport cannot be aligned without moving the page out from under the caret
  // the reader just placed.
  await page.mouse.click(box.x + box.width / 2, 300);
  await expect(page.getByLabel("Block text").first()).toBeFocused();
  const after = await page.evaluate(() => document.querySelector(".page-scroll")!.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(4);
});
