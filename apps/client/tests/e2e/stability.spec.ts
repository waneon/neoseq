import { test, expect } from "../support/fixtures";
import { boxesAround } from "../support/stability";

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
