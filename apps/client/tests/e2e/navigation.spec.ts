import { expect, test, type Locator } from "@playwright/test";
import { createGraph, createPage, openSettings } from "./helpers";

async function settledShadow(control: Locator): Promise<string> {
  return control.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(element).boxShadow;
  });
}

test("quiet and destructive buttons retain their focus edge while hovered", async ({ page }) => {
  await page.goto("/");
  const importGraph = page.getByTestId("import-graph");
  await page.keyboard.press("Tab");
  await importGraph.focus();
  await expect(importGraph).toBeFocused();
  const quietFocus = await settledShadow(importGraph);
  expect(quietFocus).toContain(" 2px inset");
  await importGraph.hover();
  await expect(importGraph).toHaveCSS("box-shadow", quietFocus);

  await createGraph(page, "Visible keyboard focus");
  await openSettings(page, "danger");
  const deleteGraph = page.getByTestId("settings-delete-graph");
  await page.keyboard.press("Tab");
  await deleteGraph.focus();
  await expect(deleteGraph).toBeFocused();
  const dangerFocus = await settledShadow(deleteGraph);
  expect(dangerFocus).toContain(" 2px inset");
  await deleteGraph.hover();
  await expect(deleteGraph).toHaveCSS("box-shadow", dangerFocus);
});

test("every journal date key retains the same complete focus edge", async ({ page }) => {
  await createGraph(page, "Date key focus");
  const keys = page.locator(".date-stepper .icon-btn");
  await page.keyboard.press("Tab");
  await keys.first().focus();
  const focus = await keys.first().evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focus).toContain("2px");
  for (const index of [1, 2]) {
    await keys.nth(index).focus();
    await expect(keys.nth(index)).toBeFocused();
    await expect(keys.nth(index)).toHaveCSS("box-shadow", focus);
  }
});

test("long page titles resize with the viewport without losing the caret", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createGraph(page, "Responsive titles");
  await createPage(
    page,
    "오래 읽고 쓰는 작업 도구를 위한 긴 페이지 이름 · Long names should wrap naturally when the window becomes narrow and should not hide any words",
  );
  const title = page.getByTestId("page-title");
  await title.focus();
  await title.press("End");
  const caret = await title.evaluate((element: HTMLTextAreaElement) => element.selectionStart);
  const desktopHeight = await title.evaluate((element) => element.clientHeight);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => title.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1);
  expect(await title.evaluate((element) => element.clientHeight)).toBeGreaterThan(desktopHeight);
  await expect(title).toBeFocused();
  expect(await title.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
    caret,
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => title.evaluate((element) => element.clientHeight)).toBe(desktopHeight);
  await expect(title).toBeFocused();
  expect(await title.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
    caret,
  );
});

for (const direction of ["ltr", "rtl"] as const) {
  test(`a collapsed desktop rail still opens as a narrow ${direction} drawer`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await createGraph(page, "Responsive navigation");
    await page.getByTestId("overflow-menu").click();
    await page.getByTestId("overflow-toggle-rail").click();
    await expect(page.locator(".shell-sidebar")).not.toBeVisible();

    // The desktop preference survives a reload, while compact drawer openness
    // belongs to the current viewport. Direction exercises the painted mirror.
    await page.reload();
    await expect(page.getByTestId("journal-title")).toBeVisible();
    await page.evaluate((dir) => {
      document.documentElement.dir = dir;
    }, direction);
    await page.setViewportSize({ width: 820, height: 700 });
    const drawer = page.locator(".shell-sidebar");
    const toggle = page.locator(".shell-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("open-settings")).toBeInViewport();
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const bounds = (await drawer.boundingBox())!;
        return bounds.x + bounds.width;
      })
      .toBeLessThanOrEqual(820);

    await page
      .locator(".shell-scrim")
      .click({ position: direction === "ltr" ? { x: 800, y: 100 } : { x: 20, y: 100 } });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(drawer).not.toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(drawer).not.toBeVisible();
  });
}
