import { NeoseqApp } from "../support/app";
import { test, expect } from "../support/fixtures";

test("a second untitled page gets the next free name", async ({ app, page }) => {
  await app.createGraph("Untitled pages");
  for (const name of ["Untitled", "Untitled 2"]) {
    await app.sidebar();
    await app.saved(() => page.getByTestId("new-page").click());
    await expect(page.getByTestId("page-title")).toHaveValue(name);
  }
});

test("a malformed document address shows a missing document, not a crash", async ({
  app,
  page,
}) => {
  await app.createGraph("Malformed address");
  const graph = new URL(page.url()).hash.split("/").slice(0, 3).join("/");
  for (const path of ["p/%E0%A4%A", "t/%"]) {
    await page.goto(`/${graph}/${path}`);
    await expect(page.getByTestId("tombstone")).toBeVisible();
  }
});

test("an address for a graph this browser does not hold opens nothing", async ({ page }) => {
  await page.goto("/");
  await page.goto("/#/g/g-not-here/journal");
  await expect(page.getByTestId("new-graph")).toBeVisible();
  await expect(page.getByText("That graph isn’t on this device.")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("open-graph-g-not-here")).toHaveCount(0);
  await expect(page.getByText("g-not-here")).toHaveCount(0);
});

test("dismissing a notification leaves Settings open", async ({ app, page }) => {
  await app.createGraph("Notice over settings");
  // A second tab opens read-only and says so in a notification.
  const second = await page.context().newPage();
  await second.goto(page.url());
  const reader = new NeoseqApp(second);
  await expect(second.getByTestId("journal-title")).toBeVisible();
  await reader.sidebar();
  await second.getByTestId("open-settings").click();
  await expect(second.getByTestId("settings-dialog")).toBeVisible();
  const notice = second.getByTestId("toast").filter({ hasText: "open in another tab" });
  await notice.getByTestId("toast-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(second.getByTestId("settings-dialog")).toBeVisible();
});

test("Forward stays available across a reload", async ({ app, page }) => {
  await app.createGraph("Forward after reload");
  await app.createPage("First");
  await app.createPage("Second");
  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveValue("First");
  await page.reload();
  const forward = page.locator(".topbar-browse").getByRole("button", { name: "Forward" });
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByTestId("page-title")).toHaveValue("Second");
});
