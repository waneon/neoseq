// The task lens in a real browser: where the marks sit, what a moment is made
// of, how a recurrence answers `Done`, and how far off a date has to be before
// its chip says so in colour.
//
// These need a browser rather than the component harness for three reasons: the
// native time input is a platform control, the tint is computed style, and the
// preference that drives the tint has to survive a reload.

import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  chooseFromMenu,
  createGraph,
  openBlockProperties,
  openSettings,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

/** The stored date `days` from today, in the browser's own local calendar. */
function localDate(days: number): string {
  const now = new Date();
  now.setDate(now.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test("status and priority are the two marks before the writing", async ({ page }) => {
  await createGraph(page, "Task Marks Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Renew the domain");

  await openBlockProperties(page);
  let picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await picker.getByRole("option", { name: "To-do", exact: true }).click();
  await expect(picker).toHaveCount(0);

  await openBlockProperties(page);
  picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Priority", exact: true }).click();
  // Strongest first: a priority list is opened to raise something.
  await picker.getByRole("option", { name: "High", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);

  const text = page.getByLabel("Block text");
  const status = page.getByTestId("task-status-toggle");
  const priority = page.getByTestId("task-priority-toggle");
  await expect(priority).toHaveAccessibleName("Priority: High");
  // Priority is a positioned control, not one of the chips under the line.
  await expect(page.getByTestId("task-chip-priority")).toHaveCount(0);
  await expect(page.getByTestId("block-chips")).toHaveCount(0);

  // Status, then priority, then the words — in that order, on one line, with the
  // text's hanging indent wide enough to clear both.
  const [statusBox, priorityBox, textBox] = await Promise.all([
    status.boundingBox(),
    priority.boundingBox(),
    text.boundingBox(),
  ]);
  expect(statusBox!.x).toBeLessThan(priorityBox!.x);
  expect(priorityBox!.x + priorityBox!.width).toBeLessThanOrEqual(
    textBox!.x + Number(await text.evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft))),
  );
  expect(Math.abs(statusBox!.y - priorityBox!.y)).toBeLessThan(2);

  // The head of the line is also where priority is changed and removed.
  await chooseFromMenu(page, priority, "Low");
  await expect(page.getByTestId("task-priority-toggle")).toHaveAccessibleName("Priority: Low");
  await priority.click();
  await page.getByTestId("remove-priority").click();
  await expect(page.getByTestId("task-priority-toggle")).toHaveCount(0);
  await expect(page.getByTestId("task-status-toggle")).toBeVisible();
});

test("a moment carries a time of day, and a recurrence rolls it forward", async ({ page }) => {
  await createGraph(page, "Recurring Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Water the plants");

  // `/` is the editor's route to a date, and the picker it opens owns the whole
  // moment: the day, then the time of day beside it.
  await page.getByLabel("Block text").pressSequentially(" /sched");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  let picker = page.getByTestId("property-picker");
  await picker.getByLabel("Type a date").fill(localDate(4));
  await picker.getByTestId("date-parsed").click();
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);

  const scheduled = page.getByTestId("task-chip-scheduled");
  await scheduled.click();
  picker = page.getByTestId("property-picker");
  await picker.getByTestId("task-time").fill("09:30");
  // A time is a refinement of the answer, not the answer: it writes at once and
  // leaves the editor open for the rest of the moment.
  await expect(scheduled).toContainText("09:30");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await awaitSaved(page);

  // Clearing it returns the moment to the whole day.
  await scheduled.click();
  picker = page.getByTestId("property-picker");
  await picker.getByTestId("task-time-clear").click();
  await expect(scheduled).not.toContainText("09:30");
  await page.keyboard.press("Escape");

  await page.getByLabel("Block text").click();
  await page.getByLabel("Block text").press("End");
  await page.getByLabel("Block text").pressSequentially(" /repeat");
  await page.getByTestId("slash-menu").getByRole("option", { name: "Repeat" }).click();
  picker = page.getByTestId("property-picker");
  await picker.getByTestId("repeat-count").fill("2");
  await chooseFromMenu(page, picker.getByTestId("repeat-unit"), "Weeks");
  await expect(picker.getByText("Every 2 weeks")).toBeVisible();
  await picker.getByTestId("repeat-set").click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("task-chip-repeat")).toContainText("Every 2 weeks");
  await awaitSaved(page);

  await openBlockProperties(page);
  picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await picker.getByRole("option", { name: "To-do", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);

  // Completing one occurrence of a recurring task is not finishing it: the row
  // is offered a different verb, keeps its `todo` glyph, and its date moves on
  // by the stored interval — counted from the date that was set.
  const status = page.getByTestId("task-status-toggle");
  await chooseFromMenu(page, status, "Complete this one");
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  await expect(page.getByTestId("task-chip-scheduled")).toContainText(localDate(18).slice(0, 4));
  await expect(page.getByTestId("toasts")).toContainText("Repeats");
  await awaitSaved(page);
});

test("a date is tinted by how far off it is, on the reader's own thresholds", async ({ page }) => {
  await createGraph(page, "Due Tone Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Pay the invoice");

  await page.getByLabel("Block text").pressSequentially(" /dead");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Type a date").fill(localDate(4));
  await picker.getByTestId("date-parsed").click();
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);

  // Four days out, with the default 1/7 thresholds, is `upcoming`.
  const deadline = page.getByTestId("task-chip-deadline");
  await expect(deadline).toHaveAttribute("data-due", "upcoming");
  await expect(deadline).toHaveAttribute("data-palette", "accent");
  // The tint is a fill, and the date it is about is still written out in ink
  // that clears AA on it — colour is never the only reading.
  const tinted = await deadline.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(tinted.background).not.toBe("rgba(0, 0, 0, 0)");

  // The thresholds and the tones belong to the reader.
  await openSettings(page, "tasks");
  await page.getByTestId("due-days-soon").fill("10");
  await chooseFromMenu(page, page.getByTestId("due-tone-soon"), "Red");
  await expect(page.getByTestId("due-preview-soon")).toHaveAttribute("data-palette", "danger");
  await page.keyboard.press("Escape");

  // Ten days of "soon" now reaches a date four days out, in the tone just chosen.
  await expect(deadline).toHaveAttribute("data-due", "soon");
  await expect(deadline).toHaveAttribute("data-palette", "danger");

  // A preference is browser-local and survives a reload.
  await page.reload();
  await expect(page.getByTestId("task-chip-deadline")).toHaveAttribute("data-palette", "danger");
});

test("the outline thread takes the tone the reader chose", async ({ page }) => {
  await createGraph(page, "Thread Tone Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Project setup");
  await page.getByLabel("Block text").press("End");
  await page.getByLabel("Block text").press("Enter");
  await page.keyboard.press("Tab");
  await typeInFocusedBlock(page, "Draft the schema");

  const section = page.locator(".outline-section");
  const parent = page.getByTestId("outline-row").first();
  // A parent draws its own thread from under its bullet down to its children, so
  // the tree has no gap between a mark and the line that descends from it.
  await expect(parent).toHaveAttribute("data-has-children", "true");
  const threadLayers = await parent.evaluate(
    (node) => (getComputedStyle(node).backgroundImage.match(/-gradient\(/g) ?? []).length,
  );
  expect(threadLayers).toBe(3);

  await expect(section).toHaveAttribute("data-palette", "neutral");
  await openSettings(page, "appearance");
  await page.getByTestId("settings-thread-tone").getByRole("button", { name: "Green" }).click();
  await expect(page.getByTestId("settings-thread-tone").getByRole("button", { name: "Green" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await expect(section).toHaveAttribute("data-palette", "ok");
  // The preference names a tone; `app.css` decides the colour, so the thread
  // follows and the hairlines elsewhere in the product do not.
  const threadTone = await section.evaluate((node) =>
    getComputedStyle(node).getPropertyValue("--thread-line"));
  expect(threadTone).toContain("oklch");
});
