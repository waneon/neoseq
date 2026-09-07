import { test, expect, FIXED_TIME } from "../support/fixtures";
import { NeoseqApp } from "../support/app";

test("the production shell boots offline and preserves edits across repeated reloads", async ({
  app,
  page,
  context,
}) => {
  await app.createGraph("Offline notebook");
  await app.startBlock("Before disconnect");
  await app.offlineReady();
  await context.setOffline(true);
  await app.appendBlock("Written offline");
  await page.reload();
  await app.expectOutline(["Before disconnect", "Written offline"]);
  await app.editBlock(0, "Revised after offline restart");
  await page.reload();
  await app.expectOutline(["Revised after offline restart", "Written offline"]);
  await context.setOffline(false);
  await page.reload();
  await app.expectOutline(["Revised after offline restart", "Written offline"]);
  expect(await page.evaluate(() => "__neoseqTest" in window)).toBe(false);
});

test("a second tab cannot write until the owning tab closes", async ({ app, page, context }) => {
  await app.createGraph("One writer");
  await app.startBlock("Owned note");
  const second = await context.newPage();
  await second.clock.setFixedTime(new Date(FIXED_TIME));
  await second.goto(page.url());
  const reader = new NeoseqApp(second);
  await expect(second.getByTestId("readonly-pill")).toBeVisible();
  await reader.expectOutline(["Owned note"]);
  await expect(reader.editors.first()).not.toBeEditable();
  await page.close();
  await second.reload();
  await expect(second.getByTestId("readonly-pill")).toHaveCount(0);
  await reader.editBlock(0, "Written by the next owner");
  await second.reload();
  await reader.expectOutline(["Written by the next owner"]);
});
