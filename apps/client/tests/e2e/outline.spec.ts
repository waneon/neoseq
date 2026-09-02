import { expect, test } from "@playwright/test";
import {
  blockLevels,
  blockTexts,
  createGraph,
  mutateAndAwaitSaved,
  openBlockMenu,
  openSidebar,
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

  await expect
    .poll(() => blockTexts(page))
    .toEqual(["parent", "child", "grandchild", "second root"]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2", "3", "1"]);

  // Keyboard traversal across the deep outline.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator('[data-testid="outline-row"] textarea').nth(1)).toBeFocused();

  // Subtree reorder: move "second root" above "parent"; its children follow.
  const secondRoot = page.locator('[data-testid="outline-row"] textarea').nth(3);
  await secondRoot.click();
  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["second root", "parent", "child", "grandchild"]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1", "2", "3"]);

  // Collapse hides the subtree without touching canonical state.
  await page.locator('[data-testid="outline-row"]').nth(1).getByLabel("Collapse").click();
  await expect.poll(() => blockTexts(page)).toEqual(["second root", "parent"]);
  await page.locator('[data-testid="outline-row"]').nth(1).getByLabel("Expand").click();
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["second root", "parent", "child", "grandchild"]);

  // Undo and redo are keyboard-and-palette verbs now; the top bar carries state,
  // not commands. The outline's textarea maps them to the *document* undo.
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["parent", "child", "grandchild", "second root"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["second root", "parent", "child", "grandchild"]);
});

test("splits a block at the caret and merges an empty block backward", async ({ page }) => {
  await createGraph(page, "Split Graph");
  await startOutline(page);
  await page.keyboard.type("headtail");
  const textarea = page.locator('[data-testid="outline-row"] textarea').first();
  await textarea.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(4, 4);
  });
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Enter"));
  await expect.poll(() => blockTexts(page)).toEqual(["head", "tail"]);

  // Backspace at the empty block's leading boundary merges it backward.
  const tail = page.locator('[data-testid="outline-row"] textarea').nth(1);
  await expect(tail).toBeFocused();
  await mutateAndAwaitSaved(page, async () => {
    await tail.selectText();
    await tail.press("Backspace");
  });
  await expect.poll(() => blockTexts(page)).toEqual(["head", ""]);
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Backspace"));
  await expect.poll(() => blockTexts(page)).toEqual(["head"]);
  await expect(page.locator('[data-testid="outline-row"] textarea').first()).toBeFocused();
});

test("leading Enter keeps block properties with the original identity and undoes once", async ({
  page,
}) => {
  await createGraph(page, "Leading Split Graph");
  await startOutline(page);
  await mutateAndAwaitSaved(page, () => page.keyboard.type("alpha"));

  await page.keyboard.press("ControlOrMeta+P");
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await mutateAndAwaitSaved(page, () =>
    picker.getByRole("option", { name: "Doing", exact: true }).click(),
  );
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing");

  const textarea = page.getByLabel("Block text");
  await textarea.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(0, 0);
  });
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Enter"));
  await expect.poll(() => blockTexts(page)).toEqual(["", "alpha"]);
  const rows = page.getByTestId("outline-row");
  await expect(rows.nth(0).getByTestId("task-status-toggle")).toHaveCount(0);
  await expect(rows.nth(1).getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Doing",
  );

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
  await mutateAndAwaitSaved(page, () => page.keyboard.type("alpha"));

  await page.keyboard.press("ControlOrMeta+z");
  await expect(textarea).toHaveValue("");

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(textarea).toHaveValue("alpha");
});

test("the bullet carries the block's menu, and every structural verb in it", async ({ page }) => {
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
  await mutateAndAwaitSaved(page, () => page.keyboard.type("one"));
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Enter"));
  await mutateAndAwaitSaved(page, () => page.keyboard.type("two"));
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Enter"));
  await mutateAndAwaitSaved(page, () => page.keyboard.type("three"));
  await expect.poll(() => blockTexts(page)).toEqual(["one", "two", "three"]);

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
    page.evaluate(
      () =>
        new Promise<{ plain: string; html: string }>((resolve) => {
          document.addEventListener(
            "copy",
            (event) => {
              resolve({
                plain: event.clipboardData?.getData("text/plain") ?? "",
                html: event.clipboardData?.getData("text/html") ?? "",
              });
            },
            { once: true },
          );
        }),
    ),
    page.keyboard.press("ControlOrMeta+c"),
  ]);
  expect(copied.plain).toBe("- one\n- two");
  expect(copied.html).not.toContain("<ul></ul>");
  expect(copied.html.match(/<li>/g)).toHaveLength(2);

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

test("keeps a bulk selection contiguous when it moves into the middle", async ({ page }) => {
  await createGraph(page, "Middle Selection Graph");
  await startOutline(page);

  await mutateAndAwaitSaved(page, () =>
    page.getByLabel("Block text").evaluate((target) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7\n- 8\n- 9");
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }),
  );
  await expect.poll(() => blockTexts(page)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

  const rows = page.getByTestId("outline-row");
  const first = await rows.nth(0).boundingBox();
  const third = await rows.nth(2).boundingBox();
  if (!first || !third) throw new Error("selection targets have no layout");
  await page.mouse.move(first.x + first.width * 0.7, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width * 0.7, third.y + third.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-selected", "true");

  const handle = await page.getByTestId("block-bullet").nth(0).boundingBox();
  const sixth = await rows.nth(5).boundingBox();
  const sixthId = await rows.nth(5).getAttribute("data-block-id");
  if (!handle || !sixth || !sixthId) throw new Error("move targets have no identity or layout");
  await mutateAndAwaitSaved(page, async () => {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, sixth.y + sixth.height - 2, { steps: 8 });
    const drop = page.getByTestId("outline-drop");
    await expect(drop).toBeVisible();
    await expect(drop).toHaveAttribute("data-after-id", sixthId);
    await page.mouse.up();
  });

  await expect.poll(() => blockTexts(page)).toEqual(["4", "5", "6", "1", "2", "3", "7", "8", "9"]);
  await expect(rows.nth(3)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(4)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(5)).toHaveAttribute("data-selected", "true");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("keeps selected passengers selected when undo restores their old hierarchy", async ({
  page,
}) => {
  await createGraph(page, "Selection Identity Graph");
  await startOutline(page);

  await mutateAndAwaitSaved(page, () =>
    page.getByLabel("Block text").evaluate((target) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "- 8\n- 2\n- 4");
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }),
  );
  await expect.poll(() => blockTexts(page)).toEqual(["8", "2", "4"]);

  const rows = page.getByTestId("outline-row");
  const second = await rows.nth(1).boundingBox();
  const third = await rows.nth(2).boundingBox();
  if (!second || !third) throw new Error("selection targets have no layout");
  await page.mouse.move(second.x + second.width * 0.7, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width * 0.7, third.y + third.height / 2, { steps: 6 });
  await page.mouse.up();

  const handle = await page.getByTestId("block-bullet").nth(1).boundingBox();
  const parent = await rows.nth(0).boundingBox();
  if (!handle || !parent) throw new Error("move targets have no layout");
  await mutateAndAwaitSaved(page, async () => {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width * 2.5, parent.y + parent.height - 2, {
      steps: 8,
    });
    await expect(page.getByTestId("outline-drop")).toBeVisible();
    await page.mouse.up();
  });
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2", "2"]);

  // The pointer range ends on `2`; `4` is selected because it is a passenger
  // of the selected `8`. That visible membership is an identity snapshot, not
  // a query to run again against the hierarchy produced by Undo.
  const selectedParent = await rows.nth(0).boundingBox();
  const firstChild = await rows.nth(1).boundingBox();
  if (!selectedParent || !firstChild) throw new Error("nested selection has no layout");
  await page.mouse.move(
    selectedParent.x + selectedParent.width * 0.7,
    selectedParent.y + selectedParent.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    firstChild.x + firstChild.width * 0.7,
    firstChild.y + firstChild.height / 2,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-selected", "true");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1", "1"]);
  await expect(rows.nth(0)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-selected", "true");
});

test("pastes Markdown list items as one outline history step", async ({ page }) => {
  await createGraph(page, "Clipboard Graph");
  await startOutline(page);

  await page.getByLabel("Block text").evaluate((target) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "- one\n  - two\n  - three\n- four");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });

  await expect.poll(() => blockTexts(page)).toEqual(["one", "two", "three", "four"]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "2", "2", "1"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => blockTexts(page)).toEqual([""]);
});

test("pastes mixed semantic HTML flow ahead of lossy plain text", async ({ page }) => {
  await createGraph(page, "HTML Clipboard Graph");
  await startOutline(page);

  await page.getByLabel("Block text").evaluate((target) => {
    const clipboard = new DataTransfer();
    clipboard.setData(
      "text/html",
      "Question?<ul><li>one<ol><li>two</li></ol></li><li>three</li></ul>",
    );
    clipboard.setData("text/plain", "Question?\none\ntwo\nthree");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });

  await expect.poll(() => blockTexts(page)).toEqual(["Question?", "one", "two", "three"]);
  await expect.poll(() => blockLevels(page)).toEqual(["1", "1", "2", "1"]);
});

test("pastes a rich outline fragment with properties and tags as one history step", async ({
  page,
}) => {
  await createGraph(page, "Rich Clipboard Graph");
  await startOutline(page);

  await page.getByLabel("Block text").evaluate((target) => {
    const fragment = {
      kind: "neoseq.outline",
      version: 2,
      source_graph_id: "external-graph",
      items: [
        {
          depth: 0,
          markdown: "portable block",
          page_references: [],
          properties: [
            {
              key: "builtin.task-status",
              value_type: "string",
              cardinality: "single",
              values: [{ type: "string", value: "doing" }],
            },
          ],
          tags: ["source-project"],
        },
      ],
      tags: [{ id: "source-project", name: "Project" }],
      pages: [],
    };
    const clipboard = new DataTransfer();
    clipboard.setData("application/vnd.neoseq.outline+json", JSON.stringify(fragment));
    clipboard.setData("text/plain", "- portable block\n  Tags: #Project");
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });

  await expect(page.getByLabel("Block text")).toHaveValue("portable block");
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing");
  await expect(page.locator(".outline-tags").getByTestId("tag-chip")).toContainText("#Project");

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByLabel("Block text")).toHaveValue("");
  await expect(page.getByTestId("task-status-toggle")).toHaveCount(0);
  await expect(page.locator(".outline-tags")).toHaveCount(0);
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
  const settledScrollTop = async (): Promise<number> => {
    let previous = Number.NaN;
    let current = Number.NaN;
    let consecutive = 0;
    await expect
      .poll(async () => {
        current = await page.evaluate(() => document.querySelector(".page-scroll")!.scrollTop);
        consecutive = Math.abs(current - previous) < 1 ? consecutive + 1 : 0;
        previous = current;
        return consecutive;
      })
      .toBeGreaterThanOrEqual(2);
    return current;
  };
  const before = await settledScrollTop();

  // "Keep the focused row visible" is right for a row that arrived from the
  // keyboard and wrong for one the pointer just pressed: a row taller than the
  // viewport cannot be aligned without moving the page out from under the caret
  // the reader just placed.
  await page.mouse.click(box.x + box.width / 2, 300);
  await expect(page.getByLabel("Block text").first()).toBeFocused();
  const after = await settledScrollTop();
  expect(Math.abs(after - before)).toBeLessThan(4);
});

// Whatever sits above the outline — a title, its properties, a tag's defaults and
// the answer to its query — the outline scrolls together with all of it. So the
// distance from the top of the page to the outline's first row is large, and it
// is not a constant. That distance is the whole of this test.
//
// A row is placed from the top of the outline, while how far the reader has come
// is measured from the top of the page. Virtualization compares those two numbers
// to decide which rows exist, so it has to be told how far apart their origins
// are; without it the rows get built for a band of the document nobody is looking
// at and the band the reader *is* looking at comes up empty. On screen that is
// blocks vanishing partway down a tag.
//
// So the measurement is the reader's own question, asked at every stop on the way
// down: is any part of the outline that is on screen missing?
const LARGEST_GAP = /* language=JavaScript */ `
(() => {
  const scroll = document.querySelector(".page-scroll");
  // A tag's query answer is an outline of its own; the tag's writing is the last.
  const outline = [...document.querySelectorAll(".outline-viewport")].pop();
  const view = scroll.getBoundingClientRect();
  const box = outline.getBoundingClientRect();
  // The band of the window the outline is answerable for.
  const top = Math.max(view.top, box.top);
  const bottom = Math.min(view.bottom, box.bottom);
  const rows = [...outline.querySelectorAll(":scope > [data-index]")]
    .map((row) => row.getBoundingClientRect())
    .filter((row) => row.bottom > top && row.top < bottom)
    .sort((a, b) => a.top - b.top);
  let cursor = top;
  let gap = 0;
  for (const row of rows) {
    gap = Math.max(gap, row.top - cursor);
    cursor = Math.max(cursor, row.bottom);
  }
  // With nothing rendered at all this is the whole band, which is the answer.
  return Math.max(gap, bottom - cursor);
})()`;

test("scrolling a tag's outline leaves no gap where a row belongs", async ({ page }) => {
  test.slow();
  await createGraph(page, "Tag Scroll Graph");

  await openSidebar(page);
  await page.getByTestId("nav-tags").click();
  await page.getByTestId("new-tag").click();
  await page.keyboard.type("design");
  await mutateAndAwaitSaved(page, () => page.keyboard.press("Enter"));
  await page.keyboard.press("Escape");

  // A tag's page carries the tallest header in the product, and most of that
  // height is the answer to its own query — so the tag needs something to answer
  // with before its page is the page a reader actually meets.
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await mutateAndAwaitSaved(page, () =>
    page.getByLabel("Block text").evaluate((target) => {
      const clipboard = new DataTransfer();
      clipboard.setData(
        "application/vnd.neoseq.outline+json",
        JSON.stringify({
          kind: "neoseq.outline",
          version: 2,
          source_graph_id: "external-graph",
          items: Array.from({ length: 15 }, (_, index) => ({
            depth: 0,
            markdown: `tagged thing ${index}`,
            page_references: [],
            properties: [],
            tags: ["design"],
          })),
          tags: [{ id: "design", name: "design" }],
          pages: [],
        }),
      );
      clipboard.setData("text/plain", "- tagged thing");
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }),
  );
  await expect(page.locator(".outline-tags").getByTestId("tag-chip")).toHaveCount(15);

  await openSidebar(page);
  await page.getByTestId("nav-tags").click();
  await page.getByTestId("tag-row-link").first().click();
  await expect(page.getByTestId("tag-title")).toHaveValue("design");

  // The answer is made of editable blocks too, so the tag's own writing has to be
  // addressed through its own section rather than by role on the whole page.
  const writing = page.locator(".outline-section").last();
  await writing.getByTestId("outline-start").click();
  const first = writing.getByLabel("Block text").first();
  await expect(first).toBeVisible();

  // Enough rows to outgrow several windows — pasted as one command rather than
  // typed as eighty.
  await mutateAndAwaitSaved(page, () =>
    first.evaluate((target) => {
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/plain",
        Array.from({ length: 80 }, (_, index) => `- row number ${index}`).join("\n"),
      );
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }),
  );

  // The header has to be tall enough for the defect to be a defect: shorter than
  // the rows virtualization renders beyond its window anyway, and this test would
  // pass on the arithmetic it exists to catch.
  const room = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(".page-scroll")!;
    const outline = [...document.querySelectorAll<HTMLElement>(".outline-viewport")].pop()!;
    return {
      scrollable: scroll.scrollHeight - scroll.clientHeight,
      header:
        outline.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
    };
  });
  expect(room.header).toBeGreaterThan(600);
  expect(room.scrollable).toBeGreaterThan(1000);

  // Down the page the way a reader goes, half a window at a time, to the end.
  const step = Math.round(page.viewportSize()!.height / 2);
  let previous = -1;
  for (;;) {
    const at = await page.evaluate((by) => {
      const scroll = document.querySelector<HTMLElement>(".page-scroll")!;
      scroll.scrollTop += by;
      return scroll.scrollTop;
    }, step);
    await expect.poll(() => page.evaluate(LARGEST_GAP)).toBeLessThan(2);
    if (at === previous) break;
    previous = at;
  }
});
