import { test, expect } from "../support/fixtures";

test("arrow keys move through a wrapped block's lines before leaving it", async ({ app, page }) => {
  await app.createGraph("Wrapped lines");
  await app.startBlock("above");
  await app.appendBlock("A paragraph long enough to wrap across several lines. ".repeat(8).trim());
  await app.appendBlock("below");
  const paragraph = app.editors.nth(1);
  await paragraph.focus();
  const middle = await paragraph.evaluate((node: HTMLTextAreaElement) => {
    const offset = Math.floor(node.value.length / 2);
    node.setSelectionRange(offset, offset);
    return offset;
  });
  await page.keyboard.press("ArrowUp");
  await expect(paragraph).toBeFocused();
  expect(await paragraph.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBeLessThan(
    middle,
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(paragraph).toBeFocused();
  expect(
    await paragraph.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
  ).toBeGreaterThan(middle);
});
