import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "../support/fixtures";

test("phone navigation creates a page and returns to saved writing through search", async ({
  app,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "The bottom navigation is the phone's primary route.");
  await app.createGraph("Pocket notebook");
  await app.startBlock("A thought from today");
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(navigation).toBeInViewport({ ratio: 1 });
  for (const control of await navigation.locator("a, button").all()) {
    const box = await control.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }

  await page.getByTestId("mobile-new-page").tap();
  const title = page.getByTestId("page-title");
  await expect(title).toHaveValue("Untitled");
  await app.saved(async () => {
    await title.fill("Pocket ideas");
    await title.press("Enter");
  });
  await app.startBlock("Keep this for later");
  const writing = page.url();
  await navigation.getByRole("link", { name: "Journal", exact: true }).tap();
  await app.expectOutline(["A thought from today"]);
  await navigation.getByRole("link", { name: "Tags", exact: true }).tap();
  await expect(page).toHaveURL(/\/tags$/);
  await page.getByTestId("mobile-search").tap();
  await page.getByTestId("command-input").fill("Pocket ideas");
  await page
    .getByRole("group", { name: "Search", exact: true })
    .getByRole("option", { name: "Pocket ideas Page", exact: true })
    .tap();
  await expect(page).toHaveURL(writing);
  await app.expectOutline(["Keep this for later"]);
  await page.reload();
  await app.expectOutline(["Keep this for later"]);
  await expect(navigation).toBeInViewport({ ratio: 1 });
});

test("touch writing tools preserve focus through structure changes and save on Done", async ({
  app,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Writing tools replace hardware keyboard shortcuts on phones.");
  await app.createGraph("Touch writing");
  await app.startBlock("Parent");
  await app.appendBlock("Child");
  const editor = app.editors.nth(1);
  await editor.tap();
  const toolbar = page.getByTestId("mobile-editor-toolbar");
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(toolbar).toBeInViewport({ ratio: 1 });
  await expect(navigation).toBeHidden();
  await expect(toolbar.getByRole("button", { name: "Outdent", exact: true })).toBeDisabled();
  await app.saved(() => toolbar.getByRole("button", { name: "Indent", exact: true }).tap());
  await expect(app.block(1)).toHaveAttribute("aria-level", "2");
  await expect(editor).toBeFocused();
  await app.saved(() => toolbar.getByRole("button", { name: "Outdent", exact: true }).tap());
  await expect(app.block(1)).toHaveAttribute("aria-level", "1");
  await expect(editor).toBeFocused();
  await app.saved(async () => {
    await editor.fill("Saved with Done");
    await toolbar.getByRole("button", { name: "Done", exact: true }).tap();
  });
  await expect(editor).not.toBeFocused();
  await expect(toolbar).toHaveCount(0);
  await expect(navigation).toBeInViewport({ ratio: 1 });
  await page.reload();
  await app.expectOutline(["Parent", "Saved with Done"]);
  await expect(app.block(1)).toHaveAttribute("aria-level", "1");
});

test("touch scrolling across block text keeps the outline unselected", async ({
  app,
  page,
  context,
  isMobile,
}) => {
  test.skip(!isMobile, "Native touch scrolling is a phone interaction.");
  await app.createGraph("Touch scrolling");
  await app.startBlock(Array.from({ length: 60 }, (_, index) => `Line ${index}`).join("\n"));
  const scroller = page.locator(".page-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  const box = await app.editors.first().boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + 40;
  const y = box!.y + 150;
  const touch = await context.newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  for (const distance of [10, 30, 60, 100]) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y - distance }],
    });
  }
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(20);
  await expect(page.locator('[data-testid="outline-row"][data-selected="true"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="outline-row"][data-focused="true"]')).toHaveCount(0);
});

test("the compact navigation drawer owns focus until its last layer closes", async ({
  app,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "The navigation drawer is the compact viewport interaction.");
  await app.createGraph("Keyboard navigation");
  const open = page.getByRole("button", { name: "Open menu", exact: true });
  const navigation = page.getByRole("navigation", { name: "Graph navigation" });
  const close = navigation.getByRole("button", { name: "Close menu", exact: true });
  const settings = navigation.getByRole("button", { name: "Settings", exact: true });

  await open.press("Enter");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(settings).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(settings).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(open).toBeFocused();

  await open.press("Enter");
  const switcher = navigation.getByTestId("graph-switcher");
  await switcher.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(switcher).toBeFocused();
  await expect(navigation).toBeVisible();

  const search = navigation.getByTestId("open-palette");
  await search.press("Enter");
  await expect(page.getByTestId("command-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();

  // Selecting the current destination still completes the navigation gesture.
  const journal = page.url();
  await open.press("Enter");
  await navigation.getByRole("link", { name: "Journal", exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page).toHaveURL(journal);
  await app.startBlock("Navigation keeps writing available");
  await app.expectOutline(["Navigation keeps writing available"]);

  // A short landscape viewport still lets the library reach its footer.
  await page.setViewportSize({ width: 568, height: 320 });
  await open.tap();
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport({ ratio: 1 });
  await settings.tap();
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settingsDialog).toBeVisible();
  const closeSettings = settingsDialog.getByRole("button", { name: "Close", exact: true });
  await expect(closeSettings).toBeInViewport({ ratio: 1 });
  await closeSettings.tap();
  await expect(settingsDialog).toHaveCount(0);
  await expect(settings).toBeFocused();
});

test("desktop sidebar controls preserve the current document and remembered preference", async ({
  app,
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop navigation can remain hidden while writing.");
  await app.createGraph("Focused writing");
  await app.startBlock("Keep this thought in view");
  const journal = page.url();
  const navigation = page.getByRole("navigation", { name: "Graph navigation" });
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  await navigation.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(show).toBeVisible();
  await expect(page).toHaveURL(journal);
  await app.expectOutline(["Keep this thought in view"]);
  await page.reload();
  await expect(show).toBeVisible();
  await expect(navigation).toBeHidden();
  await app.expectOutline(["Keep this thought in view"]);
  await show.click();
  await expect(navigation).toBeVisible();
  await expect(navigation.getByTestId("new-page")).toBeEnabled();
  await expect(page).toHaveURL(journal);
});

test("creation and navigation have usable keyboard and pointer dismissal routes", async ({
  app,
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByTestId("new-graph");
  // While the library loads, the action is shown disabled; a reader acts once it is offered.
  await expect(trigger).toBeEnabled();
  await trigger.press("Enter");
  await expect(page.getByTestId("new-graph-name")).toBeFocused();
  await page.getByTestId("new-graph-name").fill("Cancelled draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByTestId("picker-empty")).toBeVisible();

  await app.createGraph("Accessible notebook");
  const properties = page.getByTestId("page-properties-trigger");
  await properties.click();
  await expect(page.getByTestId("property-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("property-picker")).toHaveCount(0);
  await expect(properties).toBeFocused();
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

test("settings keeps a stable frame and reachable navigation while previews update", async ({
  app,
  page,
  isMobile,
}) => {
  await app.createGraph("Settings workspace");
  await app.settings("keyboard");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const frame = await dialog.boundingBox();
  expect(frame).not.toBeNull();
  const navigate = async (section: string) => {
    if (isMobile) {
      await page.getByTestId("settings-back").click();
      await expect(dialog.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    }
    const tab = page.getByTestId(`settings-tab-${section}`);
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    if (isMobile) {
      await expect(tab).toHaveCount(0);
      await expect(page.getByTestId("settings-back")).toBeInViewport({ ratio: 1 });
    } else {
      await expect(tab).toHaveAttribute("aria-current", "page");
    }
    await expect.poll(() => dialog.boundingBox()).toEqual(frame);
  };

  await navigate("journal");
  await page.getByTestId("settings-date-format").click();
  await page.getByRole("option", { name: /^ISO 8601/ }).click();
  await expect(page.getByTestId("settings-journal-preview")).toHaveText("2026-09-07");

  await navigate("tasks");
  const reset = page.getByTestId("due-tiers-reset");
  await reset.scrollIntoViewIfNeeded();
  await expect(reset).toBeInViewport({ ratio: 1 });
  await expect.poll(() => dialog.boundingBox()).toEqual(frame);
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeInViewport({ ratio: 1 });
  if (isMobile) {
    await expect(page.getByTestId("settings-back")).toBeInViewport({ ratio: 1 });
  } else {
    await expect(dialog.getByRole("navigation", { name: "Settings sections" })).toBeInViewport();
  }
  await navigate("appearance");
  await expect(page.getByTestId("settings-appearance")).toBeInViewport();
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("open-settings")).toBeFocused();
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
