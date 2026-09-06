import { expect, test, type Locator } from "@playwright/test";
import { createGraph, insertQueryBlock, startOutline, typeInFocusedBlock } from "./helpers";

async function geometry(input: Locator) {
  return input.evaluate((element: HTMLTextAreaElement) => {
    const style = getComputedStyle(element);
    return {
      height: element.clientHeight,
      width: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      maxHeight: parseFloat(style.maxHeight),
      lineHeight: parseFloat(style.lineHeight),
      gutter: style.scrollbarGutter,
      endPadding: parseFloat(style.paddingInlineEnd),
    };
  });
}

for (const wrap of [false, true]) {
  test(`long content stays readable while editing a table with wrap ${wrap}`, async ({
    page,
  }, testInfo) => {
    await createGraph(page, `Long Content ${wrap}`);
    await startOutline(page);
    await typeInFocusedBlock(page, "Long content seed");
    const source = page.locator(".outline-input").first();
    await source.press("End");
    await source.press("Enter");
    const query = page.getByTestId("query-block");
    const table = query.getByTestId("query-table");
    await insertQueryBlock(page, page.getByLabel("Block text").last(), table);

    if (wrap) {
      await query.getByTestId("query-view-trigger").click();
      await page.getByRole("menuitemcheckbox", { name: "Wrap cell text" }).click();
      await page.keyboard.press("Escape");
    }
    await expect(table.locator("table")).toHaveAttribute("data-wrap", String(wrap));
    const seed = table.getByTestId("query-edit-text").filter({ hasText: "Long content seed" });
    await seed.click();
    const editing = query.getByTestId("query-markdown-editor");
    const content = "Long content " + "긴단어abc".repeat(240);
    await editing.fill(content);
    await editing.press("Enter");
    const reading = table.getByTestId("query-edit-text").filter({ hasText: content });
    await expect(reading).toBeVisible();
    const resting = await geometry(reading);
    expect(resting.overflowX).toBe("hidden");
    expect(resting.overflowY).toBe("hidden");
    expect(resting.scrollTop).toBe(0);
    expect(resting.scrollLeft).toBe(0);
    if (!wrap) expect(resting.height).toBe(resting.lineHeight);
    await expect(reading.locator("..").locator(".query-result-clip")).toBeVisible();
    const tableWidth = await table
      .locator("table")
      .evaluate((node) => node.getBoundingClientRect().width);

    if (!wrap) {
      // Reflow an unchanged value when the reader changes the view preference.
      for (const nextWrap of [true, false]) {
        await query.getByTestId("query-view-trigger").click();
        await page.getByRole("menuitemcheckbox", { name: "Wrap cell text" }).click();
        await page.keyboard.press("Escape");
        await expect(table.locator("table")).toHaveAttribute("data-wrap", String(nextWrap));
        await expect
          .poll(async () => (await geometry(reading)).height)
          .toBe(nextWrap ? 160 : resting.height);
      }
    }

    // Activating unchanged text must remeasure immediately, before any keystroke.
    await reading.focus();
    await expect(editing).toBeFocused();
    await expect.poll(async () => (await geometry(editing)).height).toBe(160);
    const active = await geometry(editing);
    expect(active.scrollWidth).toBeLessThanOrEqual(active.width);
    expect(active.scrollHeight).toBeGreaterThan(active.height);
    expect(active.overflowX).toBe("hidden");
    expect(active.overflowY).toBe("auto");
    expect(active.gutter).toBe("stable");
    expect(active.endPadding).toBeGreaterThan(0);
    expect(
      await table.locator("table").evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(tableWidth);
    await editing.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await expect.poll(async () => (await geometry(editing)).scrollTop).toBeGreaterThan(0);
    await expect(editing).toHaveValue(content);
    await editing.screenshot({ path: testInfo.outputPath("long-content-editor.png") });
    await editing.press("Enter");
    await expect(reading).toBeVisible();
    await expect.poll(async () => (await geometry(reading)).scrollTop).toBe(0);
    await expect.poll(async () => (await geometry(reading)).height).toBe(resting.height);

    // A smaller edit grows only as much as needed; multiline source still has
    // one vertical scrollport once it reaches the same cap.
    await reading.click();
    await editing.fill("A short sentence");
    await expect.poll(async () => (await geometry(editing)).height).toBeLessThan(160);
    await editing.fill(Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const multiline = await geometry(editing);
    expect(multiline.height).toBe(160);
    expect(multiline.scrollWidth).toBeLessThanOrEqual(multiline.width);
    await editing.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await editing.pressSequentially(" final");
    await editing.press("Enter");
    await expect(source).toHaveValue(/Line 40 final$/);
    await expect(query.getByTestId("query-markdown-editor")).toHaveCount(0);
  });
}
