import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  blockTexts,
  createGraph,
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
  await awaitSaved(page);
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
  await page.getByTestId("sidebar").getByRole("button", { name: "All graphs" }).click();

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

test("second tab opens the same graph read-only", async ({ page, context }) => {
  await createGraph(page, "Lease Graph");
  const url = page.url();

  const second = await context.newPage();
  await second.goto(url);
  await expect(second.getByTestId("readonly-pill")).toBeVisible();
  await expect(second.getByTestId("undo")).toBeDisabled();
  await second.close();
});
