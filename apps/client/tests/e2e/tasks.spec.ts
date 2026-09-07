import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";

async function choose(page: Page, trigger: Locator, value: string): Promise<void> {
  await trigger.click();
  await page.getByRole("menuitemradio", { name: value, exact: true }).click();
}

test("completing one recurrence advances both dates exactly and preserves the task after reload", async ({
  app,
  page,
}) => {
  await app.createGraph("Recurring tasks");
  await app.startBlock("Water the plants");
  await app.appendBlock("Send the receipt");
  for (const index of [0, 1]) {
    await app.block(index).getByTestId("block-bullet").click({ button: "right" });
    await page.getByTestId("menu-properties").click();
    const picker = page.getByTestId("property-picker");
    await picker.getByRole("option", { name: "Status", exact: true }).click();
    await app.saved(() => picker.getByRole("option", { name: "Doing", exact: true }).click());
    await expect(picker).toHaveCount(0);
  }

  for (const [field, value] of [
    ["Scheduled", "2026-09-11 21:30 every 2 weeks"],
    ["Deadline", "2026-09-12 22:45"],
  ]) {
    await app.block(0).getByTestId("block-bullet").click({ button: "right" });
    await page.getByTestId("menu-properties").click();
    const picker = page.getByTestId("property-picker");
    await picker.getByRole("option", { name: field, exact: true }).click();
    const naturalInput = picker.getByRole("combobox", { name: "Date, time, or repeat" });
    await naturalInput.fill(value);
    await expect(picker.getByTestId("moment-search-result")).toBeVisible();
    await app.saved(() => naturalInput.press("Enter"));
    await expect(picker).toHaveCount(0);
  }

  const recurring = app.block(0);
  const ordinary = app.block(1);
  const scheduled = recurring.getByTestId("task-chip-scheduled");
  const deadline = recurring.getByTestId("task-chip-deadline");
  await expect(scheduled).toContainText("Friday, September 11, 2026");
  await expect(scheduled).toContainText("21:30");
  await expect(deadline).toContainText("Saturday, September 12, 2026");
  await expect(deadline).toContainText("22:45");
  await expect(recurring.getByTestId("task-chip-repeat")).toContainText("Every 2 weeks");

  await app.saved(() =>
    choose(page, recurring.getByTestId("task-status-toggle"), "Complete this one"),
  );
  await expect(recurring.getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: To-do",
  );
  await expect(scheduled).toContainText("Friday, September 25, 2026");
  await expect(scheduled).toContainText("21:30");
  await expect(deadline).toContainText("Saturday, September 26, 2026");
  await expect(deadline).toContainText("22:45");
  await expect(ordinary.getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Doing",
  );
  await expect(ordinary.getByTestId("task-chip-scheduled")).toHaveCount(0);
  await expect(ordinary.getByTestId("task-chip-repeat")).toHaveCount(0);

  await app.saved(() => choose(page, ordinary.getByTestId("task-status-toggle"), "Done"));
  await page.reload();
  await app.expectOutline(["Water the plants", "Send the receipt"]);
  await expect(recurring.getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: To-do",
  );
  await expect(ordinary.getByTestId("task-status-toggle")).toHaveAccessibleName(
    "Task status: Done",
  );
  await expect(scheduled).toContainText("Friday, September 25, 2026");
  await expect(scheduled).toContainText("21:30");
  await expect(deadline).toContainText("Saturday, September 26, 2026");
  await expect(deadline).toContainText("22:45");
  await expect(recurring.getByTestId("task-chip-repeat")).toContainText("Every 2 weeks");
});
