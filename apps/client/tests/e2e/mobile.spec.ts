import { expect, test } from "@playwright/test";
import {
  createGraph,
  openBlockProperties,
  openBlockTags,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

test("mobile navigation and editing remain reachable through the drawer", async ({ page }) => {
  await createGraph(page, "Mobile Graph");

  const toggle = page.locator(".shell-toggle");
  const sidebar = page.getByTestId("sidebar");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).not.toBeVisible();

  await openSidebar(page);
  await page.getByTestId("new-page").click();
  const title = page.getByTestId("page-title");
  await expect(title).toHaveValue("Untitled");
  await title.fill("Mobile Page");
  await title.press("Enter");

  await startOutline(page);
  await typeInFocusedBlock(page, "written on mobile");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");

  await openBlockProperties(page);
  const propertyPicker = page.getByTestId("property-picker");
  const propertyBox = await propertyPicker.boundingBox();
  expect(propertyBox).not.toBeNull();
  expect(propertyBox!.x).toBeCloseTo(0, 0);
  expect(propertyBox!.x + propertyBox!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect(propertyPicker.getByRole("option").first()).toHaveCSS("min-height", "48px");
  await page.keyboard.press("Escape");

  await openBlockTags(page);
  const tagPicker = page.getByTestId("tag-picker");
  const tagBox = await tagPicker.boundingBox();
  expect(tagBox).not.toBeNull();
  expect(tagBox!.x).toBeCloseTo(0, 0);
  expect(tagBox!.x + tagBox!.width).toBeCloseTo(page.viewportSize()!.width, 0);
  await expect.poll(() =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});
