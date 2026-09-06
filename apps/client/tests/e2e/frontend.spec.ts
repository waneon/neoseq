import { expect, test } from "@playwright/test";
import { createGraph, createPage, openSettings } from "./helpers";

test("page and journal actions have a visible, keyboard reachable focus owner", async ({
  page,
}) => {
  await createGraph(page, "Page actions");
  const trigger = page.getByTestId("page-actions-trigger");
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("menu-page-properties")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByTestId("menu-page-properties").click();
  await expect(page.getByTestId("property-picker").getByLabel("Property key")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("property-picker")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await createPage(page, "A place to think · 생각을 모으는 곳");
  await page.getByTestId("page-title").click({ button: "right" });
  await page.getByTestId("menu-page-info").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const search = page.getByTestId("open-palette");
  await expect(page.getByTestId("topbar-undo")).toBeVisible();
  await expect(page.getByTestId("topbar-redo")).toBeVisible();
  await expect(page.getByTestId("overflow-menu")).toHaveCount(0);
  await search.click();
  await expect(page.getByTestId("command-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(search).toBeFocused();

  await search.click();
  await page.getByTestId("command-input").fill("Settings");
  await page.getByTestId("cmd-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(search).toBeFocused();

  // A keyboard command can start with no focused control. The page provides
  // a persistent fallback after both the palette and its picker disappear.
  await search.blur();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-input").fill("Properties");
  await page.getByTestId("cmd-properties").click();
  await expect(page.getByTestId("property-picker").getByLabel("Property key")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("property-picker")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toBeFocused();
});

for (const locale of ["en-US", "ko-KR"]) {
  test.describe(locale, () => {
    test.use({ locale });

    test("a compact journal gives its date and controls independent room", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await createGraph(page, "좁은 창 · Narrow workspace");
      const title = page.getByTestId("journal-title");
      const actions = page.locator(".journal-header > .title-actions");
      const start = page.getByTestId("outline-start");
      // Empty-state guidance is visible text, not only an accessible name.
      await expect(start.locator(".outline-placeholder-label")).toBeVisible();
      await expect(start).not.toHaveText("");
      const heading = await title.boundingBox();
      const controls = await actions.boundingBox();
      expect(controls!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height);
      expect(heading!.width).toBeGreaterThan(300);
      expect(controls!.x + controls!.width).toBeLessThanOrEqual(390);
      await expect(page.getByTestId("page-actions-trigger")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    });
  });
}

test("settings stays inside a short viewport with one scrollable active pane", async ({ page }) => {
  await createGraph(page, "Short workspace");
  await page.setViewportSize({ width: 900, height: 360 });
  await openSettings(page, "tasks");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(16);
  expect(box!.y + box!.height).toBeLessThanOrEqual(344);
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport();
  const pane = page.locator(".settings-pane");
  expect(await pane.evaluate((element) => element.clientHeight < element.scrollHeight)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("open-settings")).toBeFocused();
});
