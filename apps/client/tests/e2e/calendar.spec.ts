import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createGraph } from "./helpers";

test("date entry stays visible, applies once, and returns focus", async ({ page }) => {
  await createGraph(page, "Calendar navigation");
  const trigger = page.getByTestId("journal-calendar-trigger");
  const original = await trigger.getAttribute("data-date");
  await expect(page.getByTestId("journal-date")).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Jump to date" });
  const input = dialog.getByLabel("Jump to date", { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toBeInViewport();
  await input.fill("2031-06-18");
  await expect(trigger).toHaveAttribute("data-date", original!);
  await input.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-date", "2031-06-18");
  await expect(
    page
      .getByTestId("sidebar")
      .getByRole("link", { name: "Journal", exact: true, includeHidden: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("journal-title")).toContainText("June 18, 2031");

  await trigger.click();
  await expect(input).toHaveValue("2031-06-18");
  await input.fill("2032-02-29");
  await input.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("data-date", "2031-06-18");
});

test("calendar days support keyboard selection and today", async ({ page }) => {
  await createGraph(page, "Calendar keyboard");
  const trigger = page.getByTestId("journal-calendar-trigger");
  const today = await trigger.getAttribute("data-date");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Jump to date" });
  await dialog.getByLabel("Jump to date", { exact: true }).fill("2031-06-18");
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await trigger.click();
  const selected = dialog.locator(".date-calendar-cell[data-selected]");
  await selected.focus();
  await selected.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("data-date", "2031-06-19");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "Today", exact: true }).click();
  await expect(trigger).toHaveAttribute("data-date", today!);
});

test("calendar is accessible and stays inside a narrow viewport", async ({ page }) => {
  await createGraph(page, "Calendar accessibility");
  await page.getByTestId("journal-calendar-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Jump to date" });
  await expect(dialog).toBeVisible();
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(dialog).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  const cell = await dialog.locator(".date-calendar-cell[data-selected]").boundingBox();
  expect(cell!.width).toBeGreaterThanOrEqual(32);
  expect(cell!.height).toBeGreaterThanOrEqual(32);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("journal-calendar-trigger")).toBeFocused();
});

test("month navigation keeps its frame still and journal stepping keeps focus", async ({
  page,
}) => {
  await createGraph(page, "Stable date navigation");
  const previous = page.getByRole("button", { name: "Previous day", exact: true });
  await previous.click();
  await expect(previous).toBeFocused();
  await previous.press("Enter");
  await expect(previous).toBeFocused();
  await page.getByTestId("journal-calendar-trigger").click();
  const dialog = page.getByRole("dialog", { name: "Jump to date" });
  await dialog.getByTestId("journal-date").fill("2026-02-15");
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByTestId("journal-calendar-trigger").click();
  const before = await dialog.boundingBox();
  await dialog.locator('.date-calendar-nav[slot="next"]').click();
  await expect(dialog.locator(".date-calendar-title")).toContainText("March");
  const after = await dialog.boundingBox();
  expect(after!.height).toBeCloseTo(before!.height, 0);
  expect(after!.y).toBeCloseTo(before!.y, 0);
});

for (const theme of ["light", "dark"] as const) {
  test(`native date fields follow explicit ${theme} mode over the OS`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.addInitScript((value) => localStorage.setItem("neoseq.theme", value), theme);
    await createGraph(page, "Native field theme");
    await page.getByTestId("journal-calendar-trigger").click();
    await expect(page.getByTestId("journal-date")).toHaveCSS("color-scheme", theme);
  });
}
