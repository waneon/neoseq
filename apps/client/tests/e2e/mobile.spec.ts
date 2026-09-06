import { expect, test } from "@playwright/test";
import {
  createGraph,
  openBlockProperties,
  openBlockTags,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

for (const dismissal of ["Escape", "close button"] as const) {
  test(`mobile settings returns focus to its drawer opener after ${dismissal}`, async ({
    page,
  }) => {
    await createGraph(page, "Mobile settings focus");
    await openSidebar(page);
    const opener = page.getByTestId("open-settings");
    await opener.tap();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await page.getByTestId("settings-tab-keyboard").tap();

    if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await settings.getByRole("button", { name: "Close", exact: true }).tap();

    await expect(settings).toHaveCount(0);
    await expect(opener).toBeInViewport();
    await expect(opener).toBeFocused();
  });
}

test("mobile settings opened from the keyboard restores the writing caret", async ({ page }) => {
  await createGraph(page, "Mobile settings caret");
  await startOutline(page);
  await typeInFocusedBlock(page, "Keep the writing caret here");
  const editor = page.getByLabel("Block text");
  await editor.click();
  await editor.press("Home");
  await editor.press("ArrowRight");
  const selection = await editor.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
  ]);
  await editor.press("Control+,");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((element: HTMLTextAreaElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual(selection);
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "false");
});

test("choosing the current journal still closes the mobile drawer", async ({ page }) => {
  await createGraph(page, "Mobile current route");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal", exact: true }).tap();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("journal-title")).toBeVisible();
});

test("the full-screen command palette has a touch dismissal route", async ({ page }) => {
  await createGraph(page, "Mobile commands");
  await openSidebar(page);
  await page.getByRole("button", { name: "Search pages and commands" }).tap();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  const close = palette.getByTestId("command-close");
  await expect(close).toBeInViewport();
  const box = await close.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(32);
  expect(box!.height).toBeGreaterThanOrEqual(32);
  await close.tap();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("open-palette")).toBeFocused();
});

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
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});

test("graph creation preserves usable fields on the narrowest screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  const name = page.getByTestId("new-graph-name");
  const create = page.getByTestId("create-graph");
  await expect(page.getByTestId("picker-empty")).toBeVisible();
  const field = await name.boundingBox();
  const action = await create.boundingBox();
  expect(field!.height).toBeGreaterThanOrEqual(32);
  expect(action!.height).toBeGreaterThanOrEqual(32);
  expect(action!.y).toBeGreaterThanOrEqual(field!.y + field!.height);
  expect(field!.width).toBeGreaterThanOrEqual(250);
  await name.fill("Pocket notes");
  await create.tap();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("outline-start")).toContainText("Start writing");
});
