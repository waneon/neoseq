import { expect, test } from "@playwright/test";
import { createGraph, openSidebar } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("RTL and expanded copy keep navigation inside the viewport", async ({ page }) => {
  await createGraph(page, "Bidirectional Layout Graph");
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    for (const node of document.querySelectorAll<HTMLElement>(
      ".shell-nav-item .nav-label, .rail-search .nav-label, .topbar-title",
    )) {
      const value = node.textContent ?? "";
      node.textContent = `⟦ ${value} ${value} ${value} ⟧`;
    }
  });

  const toggle = page.locator(".shell-toggle");
  await expect(toggle).toBeVisible();
  await openSidebar(page);
  const sidebar = page.getByTestId("sidebar");
  await expect.poll(async () => {
    const settled = await sidebar.boundingBox();
    return settled ? settled.x + settled.width : Number.NaN;
  }).toBeCloseTo(page.viewportSize()!.width, 0);
  const box = await sidebar.boundingBox();
  expect(box).not.toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
