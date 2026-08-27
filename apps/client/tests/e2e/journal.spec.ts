import { expect, test } from "@playwright/test";
import {
  blockTexts,
  createGraph,
  openSettings,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  (page as unknown as { __external: string[] }).__external = externalRequests;
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { __external: string[] }).__external).toEqual([]);
});

test("creates a graph, writes today's journal, and survives reload", async ({ page }) => {
  await createGraph(page, "Reload Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "captured before reload");

  await page.reload();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["captured before reload"]);
});

test("navigates journal days and keeps entries per date", async ({ page }) => {
  await createGraph(page, "Days Graph");
  const today = await page.getByTestId("journal-date").inputValue();

  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page.getByTestId("journal-date")).not.toHaveValue(today);
  await startOutline(page);
  await typeInFocusedBlock(page, "yesterday note");

  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByTestId("journal-date")).toHaveValue(today);
  await expect.poll(() => blockTexts(page)).toEqual([]);

  await page.getByRole("button", { name: "Previous day" }).click();
  await expect.poll(() => blockTexts(page)).toEqual(["yesterday note"]);
});

test("graph lifecycle: rename and explicit delete", async ({ page }) => {
  await createGraph(page, "Lifecycle");
  await openSidebar(page);
  // The rail footer no longer duplicates it: the graph switcher's own last item is
  // the one route back to the picker.
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "All graphs" }).click();

  // Row maintenance lives behind the row's ⋯ rather than beside the open action.
  await page.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Rename graph" }).click();
  await page.getByTestId("rename-graph-name").fill("Lifecycle Renamed");
  await page.getByTestId("rename-graph-submit").click();
  await expect(page.getByTestId("open-graph-Lifecycle Renamed")).toBeVisible();

  await page.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: /^Delete graph/ }).click();
  await page.getByTestId("confirm-delete-graph").click();
  await expect(page.getByTestId("picker-empty")).toBeVisible();
});

test("settings keeps graph deletion inside the confirmation transaction", async ({ page }) => {
  await createGraph(page, "Settings Delete");
  await openSettings(page, "danger");
  await page.getByTestId("settings-delete-graph").click();
  const confirmation = page.getByTestId("settings-confirm-delete");
  await confirmation.click();
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByTestId("picker-empty")).toBeVisible();
});

test("second tab opens the same graph read-only", async ({ page, context }) => {
  await createGraph(page, "Lease Graph");
  const url = page.url();

  const second = await context.newPage();
  await second.goto(url);
  await expect(second.getByTestId("readonly-pill")).toBeVisible();
  // The top bar carries state, not commands, so read-only is stated there and
  // enforced where the writing happens: the outline offers nothing to write in.
  await expect(second.getByTestId("outline-start")).toBeDisabled();
  await second.close();
});

test("names the product once in the rail, and again in the tab", async ({ page }) => {
  await createGraph(page, "Brand Graph");
  await openSidebar(page);

  // The rail says it, above the graph switcher, with the mark beside it.
  const brand = page.getByTestId("brand");
  await expect(brand).toHaveText("Neoseq");
  await expect(brand.locator("svg")).toBeVisible();

  // And the tab: the title comes from the locale catalog, the icon from a real
  // asset that the production bundle actually ships.
  await expect(page).toHaveTitle("Neoseq");
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("type", "image/svg+xml");
  const href = await icon.getAttribute("href");
  const response = await page.request.get(new URL(href ?? "", page.url()).href);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("<svg");
});
