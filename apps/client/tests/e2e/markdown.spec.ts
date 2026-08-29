import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createGraph, mutateAndAwaitSaved, startOutline } from "./helpers";

/** Fills the first block, then parks focus on a new sibling so the block rests
    in its reading projection. */
async function writeBlock(page: Page, source: string): Promise<void> {
  await mutateAndAwaitSaved(page, async () => {
    await page.getByLabel("Block text").fill(source);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
  });
}

test("renders safe Markdown at rest and restores its source editor", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/")) {
      externalRequests.push(request.url());
    }
  });

  await createGraph(page, "Markdown Graph");
  await startOutline(page);
  const source = [
    "# Release note",
    "",
    "Read **bold text** with [source](https://example.com) and [unsafe](javascript:alert(1)).",
    "",
    "![diagram](https://example.com/tracker.png)",
  ].join("\n");
  await writeBlock(page, source);

  const projection = page.getByTestId("block-markdown");
  await expect(projection.getByRole("heading", { level: 2, name: "Release note" })).toBeVisible();
  await expect(projection.locator("strong")).toHaveText("bold text");
  await expect(projection.getByRole("link", { name: "source" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(projection.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  await expect(projection.locator("img")).toHaveCount(0);
  await expect(projection.locator(".markdown-image-alt")).toHaveText("diagram");
  expect(externalRequests).toEqual([]);
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(audit.violations).toEqual([]);

  await projection.getByRole("heading", { name: "Release note" }).click();
  const editor = page.getByLabel("Block text").first();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(source);
});

test("returns to the projection when focus leaves the outline entirely", async ({ page }) => {
  await createGraph(page, "Markdown Blur Graph");
  await startOutline(page);
  await writeBlock(page, "Read **bold text** here.");

  const projection = page.getByTestId("block-markdown").first();
  await projection.click();
  const editor = page.getByLabel("Block text").first();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("Read **bold text** here.");

  // The rest of the app is not the outline. A press on the journal's own heading
  // takes focus nowhere at all — which is the case the row could not see: a blur
  // says only that the textarea lost focus, never where focus went. The block used
  // to sit on its raw source from that press until the next reload.
  await page.getByTestId("journal-title").click();
  await expect(page.getByTestId("block-markdown").first()).toBeVisible();
  await expect(page.getByTestId("block-markdown").first().locator("strong")).toHaveText(
    "bold text",
  );

  // …and the row's own furniture is not "outside" it: opening the block's menu
  // must leave the editor open underneath the thing that is opening.
  await projection.click();
  await expect(page.getByLabel("Block text").first()).toBeFocused();
  await page.getByTestId("block-bullet").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByLabel("Block text").first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("renders the structure people write, and keeps their line breaks", async ({ page }) => {
  await createGraph(page, "Markdown Dialect");
  await startOutline(page);
  const source = [
    "| Column | Value |",
    "| --- | --- |",
    "| One | 1 |",
    "",
    "- first item",
    "- second item",
    "",
    "~~dropped~~ at https://example.com/docs",
    "A line the author broke.",
  ].join("\n");
  await writeBlock(page, source);

  const projection = page.getByTestId("block-markdown");
  await expect(projection.getByRole("columnheader", { name: "Column" })).toBeVisible();
  await expect(projection.getByRole("cell", { name: "One" })).toBeVisible();
  await expect(projection.locator("del")).toHaveText("dropped");
  await expect(projection.getByRole("link", { name: "https://example.com/docs" })).toBeVisible();
  // Markers, not indented paragraphs: preflight clears them and the profile has
  // to put them back.
  const marker = await projection
    .locator("li")
    .first()
    .evaluate((element) => getComputedStyle(element).listStyleType);
  expect(marker).toBe("disc");
  // A soft break is a break, so the two sentences do not become one line.
  await expect(projection.locator("br")).toHaveCount(1);
});

test("opens the source editor at the pressed word, whole and reachable", async ({ page }) => {
  await createGraph(page, "Markdown Caret");
  await startOutline(page);
  const source = [
    "# Release notes",
    "",
    "Important: this release adds **Markdown rendering** to every block.",
    "",
    "- first item",
    "- second item",
    "",
    "The last line of a long block.",
  ].join("\n");
  await writeBlock(page, source);

  // A reload is what makes this real: the textarea mounts hidden, so anything
  // that measures it before it is shown measures nothing.
  await page.reload();
  const projection = page.getByTestId("block-markdown").first();
  await expect(projection).toBeVisible();

  await projection.getByText("second item").click();
  const editor = page.getByLabel("Block text").first();
  await expect(editor).toBeFocused();

  // The caret belongs where the reader pressed, not at the end of the source.
  const caret = await editor.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
  expect(caret).toBeGreaterThanOrEqual(source.indexOf("second item"));
  expect(caret).toBeLessThanOrEqual(source.indexOf("second item") + "second item".length);

  // And the editor opens showing the whole block, not clipped to its first line.
  const box = await editor.evaluate((el: HTMLTextAreaElement) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(box.client).toBeGreaterThanOrEqual(box.scroll);
});

test("leaves a drag to the outline, and stays reachable by keyboard", async ({ page }) => {
  await createGraph(page, "Markdown Pointer");
  await startOutline(page);
  await writeBlock(page, "Read **bold text** and then some more writing.");
  await page.reload();

  const projection = page.getByTestId("block-markdown").first();
  const word = projection.getByText("more writing", { exact: false });
  const box = await word.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  // A drag over quiet writing surface is the outline's block range selection.
  // The projection must not answer the same gesture by opening an editor, which
  // would undo the selection the drag just made.
  await expect(page.locator('[data-testid="outline-row"]').first()).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.getByLabel("Block text").first()).toBeHidden();

  // The projection stands in for the textarea, so it stands in for its tab stop:
  // a page of rendered blocks still has a way in.
  await page.reload();
  await expect(page.getByTestId("block-markdown").first()).toBeVisible();
  let reached = false;
  for (let press = 0; press < 40 && !reached; press += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => document.activeElement?.classList.contains("outline-input") ?? false,
    );
  }
  expect(reached).toBe(true);
  await expect(page.getByLabel("Block text").first()).toBeFocused();
});
