import { test, expect, FIXED_TIME } from "../support/fixtures";
import { NeoseqApp } from "../support/app";
import { boxesAround, layoutDifferences, layoutOf } from "../support/stability";

// Pressing a control changes its own region; nothing beside it moves.

test("journal day controls hold still as Today comes and goes", async ({ app, page }) => {
  await app.createGraph("Steady days");
  const nav = page.getByRole("group", { name: "Journal", exact: true });
  const steady = [
    nav.getByRole("button", { name: "Previous day", exact: true }),
    page.getByTestId("journal-calendar-trigger"),
    nav.getByRole("button", { name: "Next day", exact: true }),
  ];
  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 800 },
  ]) {
    await page.setViewportSize(size);
    for (const press of [steady[0], nav.getByRole("button", { name: "Today", exact: true })]) {
      const { before, after } = await boxesAround(steady, async () => {
        const title = await page.getByTestId("journal-title").textContent();
        await press.click();
        await expect(page.getByTestId("journal-title")).not.toHaveText(title!);
        await app.settled();
      });
      expect(after, `${size.width}px`).toEqual(before);
    }
  }
});

test("sorting a directory keeps every column label in place", async ({ app, page }) => {
  await app.createGraph("Sorted shelf");
  for (const title of ["Alpha", "Beta"]) await app.createPage(title);
  await app.sidebar();
  await page.getByTestId("nav-pages").click();
  const directory = page.getByTestId("pages-directory");
  const sorts = directory.locator(".directory-sort");
  await expect(sorts).toHaveCount(3);
  // Labels are the sort buttons' text; their marks may appear beside them.
  const labels = () =>
    sorts.evaluateAll((buttons) =>
      buttons.map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button.firstChild!);
        const { left, top } = range.getBoundingClientRect();
        return [left, top];
      }),
    );
  for (const index of [1, 2, 1, 0]) {
    const before = await labels();
    await sorts.nth(index).click();
    await expect(sorts.nth(index)).toHaveAttribute("aria-sort", /ascending|descending/);
    expect(await labels()).toEqual(before);
  }
});

test("adding a sort term keeps the result tools in place", async ({ app, page }) => {
  await app.createGraph("Ordered answers");
  await app.createPage("Records");
  await app.startBlock("");
  await app.editors.last().pressSequentially("/quer");
  await app.saved(() =>
    page
      .getByTestId("slash-menu")
      .getByRole("option", { name: /^Query/ })
      .click(),
  );
  const query = page.getByTestId("query-block");
  const tools = query.locator(".query-result-tools > *");
  await expect(query.getByTestId("query-sort-trigger")).toBeVisible();
  const steady = await tools.all();
  const { before, after } = await boxesAround(steady, async () => {
    await query.getByTestId("query-sort-trigger").click();
    await page.getByTestId("query-sort-add").click();
    await app.saved(() => page.getByRole("option").first().click());
    await expect(query.getByTestId("query-sort-trigger")).toHaveAttribute("data-sorted", "true");
  });
  expect(after).toEqual(before);
});

// A second tab reads the graph the first one writes. Read-only takes away the
// ability to commit, never a place on the page: the reader's controls stand
// where the writer's do, disabled, so nothing the writer sees moves.
test("a reader tab lays out every surface where the writer's tab does", async ({
  app,
  page,
  context,
}) => {
  await app.createGraph("Mirror");
  await app.startBlock("Journal note");
  await app.appendBlock("Second line");
  await app.settings("queries");
  await app.saved(() => page.getByTestId("add-default-query").click());
  await page.keyboard.press("Escape");
  await app.saved(() => page.getByTestId("query-conditions-trigger").first().click());
  await expect(page.getByTestId("query-builder")).toBeVisible();
  const journal = page.url();

  await app.createPage("Records");
  await app.startBlock("Tagged record");
  await app.block(0).getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-tags").click();
  const picker = page.getByTestId("tag-picker");
  await picker.getByTestId("tag-autocomplete").fill("Project");
  await app.saved(() => picker.getByRole("option", { name: /Create tag/ }).click());
  await page.keyboard.press("Escape");
  const records = page.url();
  const tag = new URL(
    (await app.block(0).getByTestId("tag-chip").getAttribute("href"))!,
    page.url(),
  ).href;
  const tags = journal.replace(/journal$/, "tags");

  const reader = await context.newPage();
  await reader.clock.setFixedTime(new Date(FIXED_TIME));
  const readerApp = new NeoseqApp(reader);
  // The pill names the reader's state. The bar makes room for it from the
  // graph's name, which already gives way on a phone, and moves no control.
  const notice = '[data-testid="toasts"], [data-testid="readonly-pill"], .sr-only';
  const layout = async (target: typeof page) => ({
    ...(await layoutOf(target, "body", `${notice}, .shell-topbar`)),
    ...(await layoutOf(target, ".topbar-start, .topbar-end", `${notice}, .mobile-workspace`)),
  });
  for (const size of [
    { width: 1280, height: 720 },
    { width: 390, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await reader.setViewportSize(size);
    for (const url of [journal, records, tags, tag]) {
      await page.goto(url);
      await reader.goto(url);
      await expect(reader.getByTestId("readonly-pill")).toBeVisible();
      await app.settled();
      await readerApp.settled();
      expect(
        layoutDifferences(await layout(page), await layout(reader)),
        `${size.width}px ${url}`,
      ).toEqual([]);
    }
  }
});
