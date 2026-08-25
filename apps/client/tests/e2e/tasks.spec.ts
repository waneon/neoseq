// The task lens in a real browser: where the marks sit, what a moment is made
// of, how a recurrence answers `Done`, and how far off a date has to be before
// its chip says so in colour.
//
// These need a browser rather than the component harness for three reasons: the
// native time input is a platform control, the tint is computed style, and the
// preference that drives the tint has to survive a reload.

import { expect, test, type Locator } from "@playwright/test";
import {
  chooseFromMenu,
  createGraph,
  mutateAndAwaitSaved,
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
  await mutateAndAwaitSaved(page, () =>
    picker.getByRole("option", { name: "To-do", exact: true }).click());
  await expect(picker).toHaveCount(0);

  await openBlockProperties(page);
  picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Priority", exact: true }).click();
  // Strongest first: a priority list is opened to raise something.
  await mutateAndAwaitSaved(page, () =>
    picker.getByRole("option", { name: "High", exact: true }).click());
  await expect(picker).toHaveCount(0);

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

  // One mark language. Priority used to carry a 24px tinted tile behind its bars
  // to hold its own beside a filled status disc, and a tile at the head of a line
  // of writing is the loudest box on the row; the bars grew instead, so neither
  // mark has a fill of its own at rest.
  const fills = await Promise.all(
    [status, priority].map((mark) =>
      mark.evaluate((node) => getComputedStyle(node).backgroundColor)),
  );
  expect(fills[0]).toBe("rgba(0, 0, 0, 0)");
  expect(fills[1]).toBe(fills[0]);

  // The head of the line is also where priority is changed and removed.
  await mutateAndAwaitSaved(page, () => chooseFromMenu(page, priority, "Low"));
  await expect(page.getByTestId("task-priority-toggle")).toHaveAccessibleName("Priority: Low");
  await priority.click();
  await mutateAndAwaitSaved(page, () => page.getByTestId("remove-priority").click());
  await expect(page.getByTestId("task-priority-toggle")).toHaveCount(0);
  await expect(page.getByTestId("task-status-toggle")).toBeVisible();
});

test("a moment carries a time of day, and a recurrence rolls it forward", async ({ page }) => {
  await createGraph(page, "Recurring Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Water the plants");

  // Shape recurrence while the resting row is the only active surface. Later
  // moment pickers can restore the caret without immediately being followed by
  // a different anchored picker.
  await openBlockProperties(page);
  let picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Repeat", exact: true }).click();
  await picker.getByTestId("repeat-count").fill("2");
  await chooseFromMenu(page, picker.getByTestId("repeat-unit"), "Weeks");
  await expect(picker.getByText("Every 2 weeks")).toBeVisible();
  await mutateAndAwaitSaved(page, () => picker.getByTestId("repeat-set").click());
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("task-chip-repeat")).toContainText("Every 2 weeks");

  await openBlockProperties(page);
  picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await mutateAndAwaitSaved(page, () =>
    picker.getByRole("option", { name: "To-do", exact: true }).click());
  await expect(picker).toHaveCount(0);

  // `/` is the editor's route to a moment. Search resolves the date and 24-hour
  // clock together; Done persists that whole draft as one operation.
  await page.getByLabel("Block text").pressSequentially(" /sched");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  picker = page.getByTestId("property-picker");
  await picker.getByLabel("Date or time").fill(`${localDate(4)} 21:30`);
  await picker.getByTestId("moment-search-result").click();
  await mutateAndAwaitSaved(page, () => picker.getByTestId("moment-apply").click());
  await expect(picker).toHaveCount(0);

  const scheduled = page.getByTestId("task-chip-scheduled");
  await expect(scheduled).toContainText("21:30");
  await expect(scheduled).not.toContainText(/AM|PM/);

  // Switching the optional clock off and applying returns the moment to its
  // whole day without removing the date.
  await scheduled.click();
  picker = page.getByTestId("property-picker");
  await picker.getByTestId("moment-time-toggle").click();
  await mutateAndAwaitSaved(page, () => picker.getByTestId("moment-apply").click());
  await expect(scheduled).not.toContainText("21:30");
  await expect(picker).toHaveCount(0);

  // Completing one occurrence of a recurring task is not finishing it: the row
  // is offered a different verb, keeps its `todo` glyph, and its date moves on
  // by the stored interval — counted from the date that was set.
  const status = page.getByTestId("task-status-toggle");
  await mutateAndAwaitSaved(page, () => chooseFromMenu(page, status, "Complete this one"));
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  await expect(page.getByTestId("task-chip-scheduled")).toContainText(localDate(18).slice(0, 4));
  await expect(page.getByTestId("toasts")).toContainText("Repeats");
});

test("a date is tinted by how far off it is, on the reader's own thresholds", async ({ page }) => {
  await createGraph(page, "Due Tone Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "Pay the invoice");

  await page.getByLabel("Block text").pressSequentially(" /dead");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Date or time").fill(localDate(4));
  await picker.getByTestId("moment-search-result").click();
  await mutateAndAwaitSaved(page, () => picker.getByTestId("moment-apply").click());
  await expect(picker).toHaveCount(0);

  // Four days out, with the default 3/7 calendar-day spans, is `upcoming` — and blue on
  // its own account, not the accent's: a step in an ordered scale may not change
  // colour because somebody chose a different accent.
  const deadline = page.getByTestId("task-chip-deadline");
  await expect(deadline).toHaveAttribute("data-due", "upcoming");
  await expect(deadline).toHaveAttribute("data-palette", "info");
  // The tint is a fill, and the date it is about is still written out in ink
  // that clears AA on it — colour is never the only reading.
  const tinted = await deadline.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(tinted.background).not.toBe("rgba(0, 0, 0, 0)");

  const firstLine = page.getByLabel("Block text");
  await firstLine.click();
  await firstLine.press("End");
  await firstLine.press("Enter");
  await typeInFocusedBlock(page, "Archive the receipt");
  const rhythm = await deadline.evaluate((chip) => {
    const row = chip.closest<HTMLElement>("[data-testid='outline-row']")!;
    const line = row.querySelector<HTMLElement>(".block-line")!;
    const strip = row.querySelector<HTMLElement>(".block-chips")!;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-testid='outline-row']")];
    const nextLine = rows[rows.indexOf(row) + 1].querySelector<HTMLElement>(".block-line")!;
    return {
      textToProperty: strip.getBoundingClientRect().top - line.getBoundingClientRect().bottom,
      propertyToNext: nextLine.getBoundingClientRect().top - strip.getBoundingClientRect().bottom,
    };
  });
  // Metadata belongs to its text, and one chip must not turn the next sibling
  // into a new paragraph. The four pixels after it are the ordinary row seam.
  expect(rhythm).toEqual({ textToProperty: 0, propertyToNext: 4 });

  // The thresholds and the tones belong to the reader.
  await openSettings(page, "tasks");
  const tierVisual = (tier: "today" | "soon") =>
    page.getByTestId(`due-preview-${tier}`).evaluate((node) => {
      const style = getComputedStyle(node);
      return { tone: style.getPropertyValue("--tone").trim(), shadow: style.boxShadow };
    });
  const [todayVisual, soonVisual] = await Promise.all([
    tierVisual("today"),
    tierVisual("soon"),
  ]);
  expect(todayVisual.tone).not.toBe(soonVisual.tone);
  // Today is distinguished by its warmer colour, not a heavier outline: every
  // due tier keeps the same quiet one-pixel boundary.
  expect(todayVisual.shadow).toMatch(/1px inset$/);
  expect(soonVisual.shadow).toMatch(/1px inset$/);

  await page.getByTestId("due-days-soon").fill("10");
  // One well opens the colour itself: hue and intensity move continuously, and
  // the resulting OKLCH coordinates repaint the real preview in place.
  await page.getByTestId("due-tone-soon").click();
  const colour = page.getByTestId("due-tone-soon-picker");
  await colour.getByLabel("Hue").fill("330");
  await colour.getByLabel("Intensity").fill("0.18");
  await expect(page.getByTestId("due-preview-soon")).toHaveAttribute("style", /0\.18 330/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Ten calendar days of "soon" now reach a date four days out, in the tone just chosen.
  await expect(deadline).toHaveAttribute("data-due", "soon");
  await expect(deadline).toHaveAttribute("style", /0\.18 330/);

  // A preference is browser-local and survives a reload.
  await page.reload();
  await expect(page.getByTestId("task-chip-deadline")).toHaveAttribute("style", /0\.18 330/);
});

test("the outline is one hue at two weights, and only the live path is drawn", async ({
  page,
}) => {
  await createGraph(page, "Branch Graph");
  await startOutline(page);
  // Four levels, with a sibling above the caret at the deepest one. Three levels
  // would not do: the defect this measures only appears once the path has turned
  // off more than one column above the row being drawn.
  await typeInFocusedBlock(page, "Project setup");
  for (const line of ["Draft the schema", "Add the columns", "Name them"]) {
    await page.getByLabel("Block text").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await typeInFocusedBlock(page, line);
  }
  await page.getByLabel("Block text").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, "Order them");
  // `typeInFocusedBlock` blurs when it is done; the caret is what lights a path,
  // so put it back in the block this test is about.
  await page.getByLabel("Block text").last().click();

  const rows = page.getByTestId("outline-row");
  const root = rows.first();
  const passed = rows.nth(3);
  const caret = rows.nth(4);
  await expect(rows).toHaveCount(5);
  await expect(caret).toHaveAttribute("data-focused", "true");
  await expect(caret).toHaveAttribute("aria-level", "4");

  const branch = (locator: Locator) =>
    locator.evaluate((node) => {
      const before = getComputedStyle(node, "::before");
      return {
        drawn: before.content !== "none",
        left: Math.round(parseFloat(before.left)),
        width: before.borderLeftWidth,
        radius: before.borderBottomLeftRadius,
        colour: before.borderLeftColor,
      };
    });

  // The branch is a "you are here" instrument, so it is drawn only where the path
  // actually goes: on the caret's row and on its ancestors, and nowhere else.
  // Drawn beside every bullet it was wallpaper.
  expect((await branch(root)).drawn).toBe(false);
  expect((await branch(passed)).drawn).toBe(false);
  const stroke = await branch(caret);
  expect(stroke.drawn).toBe(true);
  // One indent left of its own bullet, a real rounded corner, and twice the
  // weight of the guides it runs along. 33 = gutter 24 + slot/2 10 + two indents
  // for its own depth, less half the stroke's width.
  expect(stroke.left).toBe(93);
  expect(stroke.radius).toBe("10px");
  expect(stroke.width).toBe("2px");

  // ── Only the path, and only the part of it still in flight ──
  // The live stroke is a polyline, so at a row it does not reach exactly one
  // column of it is still descending: the deepest ancestor above that row. Drawn
  // as "the first N columns" instead, every level the path had already turned off
  // was redrawn at full weight, and a sibling four levels deep grew three bold
  // stubs standing in the middle of nowhere.
  const liveBar = (locator: Locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      const [size] = style.backgroundSize.split(",").slice(1, 2);
      const [position] = style.backgroundPosition.split(",").slice(1, 2);
      return { size: size.trim(), position: position.trim() };
    });

  // The sibling above the caret sits at depth 3 with three ancestors above it, so
  // it carries exactly one 2px bar, at its parent's column and no further left.
  const bar = await liveBar(passed);
  expect(bar.size.split(" ")[0]).toBe("2px");
  expect(bar.position.split(" ")[0]).toBe("93px");
  // The rows the path arrives at draw none of it — there the branch is the stroke.
  expect((await liveBar(caret)).size.split(" ")[0]).toBe("0px");
  expect((await liveBar(root)).size.split(" ")[0]).toBe("0px");

  // One hue, two weights: the guide is the accent held back, the stroke is the
  // accent itself, and the reader chooses neither separately from the other.
  const tones = await page.locator(".outline-section").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      guide: style.getPropertyValue("--thread-line").trim(),
      lit: style.getPropertyValue("--thread-lit").trim(),
    };
  });
  expect(tones.guide).toContain("color-mix");
  expect(tones.guide).toContain("22%");
  expect(tones.lit).toContain("oklch");

  // The path's marks belong to the path, so the accent moves them too. Polled,
  // because the dot transitions into its new tone and a colour caught mid-way
  // through an 80ms interpolation is neither of the two it is between.
  const accent = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
  const dotOf = (row: Locator) =>
    row.evaluate((node) =>
      getComputedStyle(node.querySelector(".outline-bullet")!, "::after").backgroundColor);
  await expect.poll(() => dotOf(caret)).toBe(accent);
  await expect.poll(() => dotOf(root)).toBe(accent);
  // And a row the path does not reach keeps the resting mark.
  expect(await dotOf(passed)).not.toBe(accent);

  // There is nothing to choose: the thread's own colour preference is gone. This
  // is last because opening a dialog takes the caret, and the caret is what all
  // of the above is about.
  await openSettings(page, "appearance");
  await expect(page.getByTestId("settings-thread-tone")).toHaveCount(0);
  await expect(page.getByTestId("settings-accent")).toBeVisible();
});

test("the accent is a hue the reader owns, applied before the first paint", async ({ page }) => {
  await createGraph(page, "Accent Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "a block to select");

  // Nothing is written to the root until a reader chooses: iris is the default in
  // `app.css`, so an untouched install carries no override at all.
  const override = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--accent-h"));
  expect(override).toBe("");
  const iris = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent-h").trim());
  expect(iris).toBe("277");

  await openSettings(page, "appearance");
  await expect(page.getByTestId("settings-accent").getByRole("button")).toHaveCount(9);
  await page.getByTestId("settings-accent-custom").click();
  const picker = page.getByTestId("settings-accent-picker");
  await expect(picker).toBeVisible();
  const hue = page.getByTestId("settings-accent-hue");
  await hue.focus();
  await page.keyboard.press("Home");
  await expect(hue).toHaveValue("0");
  await page.keyboard.press("Escape");

  // One number on the root is the whole mechanism: everything the accent touches
  // is already written in terms of `--accent`, so nothing else had to change.
  await expect(page.locator("html")).toHaveAttribute("style", /--accent-h:\s*0/);
  const custom = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });

  // Appearance is browser-wide and has to be on screen before the first frame,
  // or a chosen accent flashes iris on every launch.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("style", /--accent-h:\s*0/);
  const afterReload = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  });
  expect(afterReload).toBe(custom);

  // The lightness is not the reader's, which is what keeps every hue on the
  // measured row of the contrast table: only the hue moved.
  const light = await page.evaluate(() =>
    Number(getComputedStyle(document.documentElement).getPropertyValue("--accent-l")));
  expect(light).toBe(0.535);
});
