import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";

test("creation and navigation have usable keyboard and pointer dismissal routes", async ({
  app,
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByTestId("new-graph");
  await trigger.press("Enter");
  await expect(page.getByTestId("new-graph-name")).toBeFocused();
  await page.getByTestId("new-graph-name").fill("Cancelled draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("picker-empty")).toBeVisible();

  await app.createGraph("Accessible notebook");
  await app.startBlock("My writing");
  await app.sidebar();
  await page.getByTestId("open-palette").click();
  await expect(page.getByTestId("command-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await app.createPage("새로운 생각 · Notes");
  await app.startBlock("A second place to write");
  await app.sidebar();
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal", exact: true }).click();
  await app.expectOutline(["My writing"]);
  const calendar = page.getByTestId("journal-calendar-trigger");
  await calendar.click();
  const dialog = page.getByRole("dialog", { name: "Jump to date" });
  const date = dialog.getByLabel("Jump to date", { exact: true });
  await expect(date).toBeFocused();
  await date.fill("2026-09-08");
  await date.press("Escape");
  await expect(calendar).toBeFocused();
  await expect(calendar).toHaveAttribute("data-date", "2026-09-07");
  await calendar.click();
  await date.fill("2026-09-08");
  await date.press("Enter");
  await expect(calendar).toHaveAttribute("data-date", "2026-09-08");
  await app.expectOutline([]);
  await app.startBlock("Tomorrow's note");
  await calendar.click();
  await dialog.getByRole("button", { name: "Today", exact: true }).click();
  await app.expectOutline(["My writing"]);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
  await expect(app.editors.first()).toBeInViewport();
});

test("language preferences survive reload without changing graph content", async ({
  app,
  page,
}) => {
  await app.createGraph("언어 설정");
  await app.startBlock("English and 한국어 stay intact");
  const journal = page.url();
  await app.settings("language");
  await page.getByTestId("settings-language").click();
  await page.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("settings-language")).toContainText("한국어");
  await page.goto(journal);
  await expect(page.getByTestId("outline-row").locator("textarea")).toHaveValue(
    "English and 한국어 stay intact",
  );
});

test("populated writing, property controls and settings pass accessibility audits", async ({
  app,
  page,
}, testInfo) => {
  const audit = async (name: string) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    await testInfo.attach(name, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
    expect(results.violations).toEqual([]);
  };
  await page.goto("/");
  await audit("graph-picker-a11y");
  await app.createGraph("Accessibility");
  await app.startBlock("Review the release");
  await app.editors.first().click();
  await page.keyboard.press("ControlOrMeta+p");
  const picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await app.saved(() => picker.getByRole("option", { name: "To-do", exact: true }).click());
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  await audit("populated-outline-a11y");
  await page.getByTestId("journal-calendar-trigger").click();
  await expect(page.getByRole("dialog", { name: "Jump to date" })).toBeVisible();
  await audit("calendar-a11y");
  await page.keyboard.press("Escape");
  await app.settings();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await audit("settings-a11y");
});
