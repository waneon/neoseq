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
