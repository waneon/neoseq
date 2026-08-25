import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  blockTexts,
  createGraph,
  savedSequence,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

test("keeps editing the same graph offline, across a reload", async ({ page, context }) => {
  await createGraph(page, "Offline Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "written online");

  // Wait for the shell Service Worker so an offline reload can boot.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  await context.setOffline(true);

  // Editing keeps working offline: storage is local-first.
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, "written offline");

  // Restart the app while still offline.
  await page.reload();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect.poll(() => blockTexts(page)).toEqual(["written online", "written offline"]);

  // And continue editing after the offline restart.
  await page.locator('[data-testid="outline-row"] textarea').nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, "after offline restart");

  await context.setOffline(false);
  await page.reload();
  await expect
    .poll(() => blockTexts(page))
    .toEqual(["written online", "written offline", "after offline restart"]);
});

test("storage failures show an unsaved state with a working retry", async ({ page }) => {
  await createGraph(page, "Recovery Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "durable baseline");
  const baseline = await savedSequence(page);

  // Inject a one-shot IndexedDB transaction abort at the Worker boundary.
  await page.evaluate(() => window.__neoseqTest!.injectStorageFault("abort"));
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus more");
  await page.locator('[data-testid="outline-row"] textarea').first().blur();

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "unsaved");
  await page.getByTestId("retry-save").click();
  await awaitSaved(page, baseline);

  // The retried bytes were the exact pending update.
  await page.reload();
  await expect.poll(() => blockTexts(page)).toEqual(["durable baseline plus more"]);
});

test("quota exhaustion is reported as a typed storage-full state", async ({ page }) => {
  await createGraph(page, "Quota Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "before quota");
  const baseline = await savedSequence(page);

  await page.evaluate(() => window.__neoseqTest!.injectStorageFault("quota"));
  await page.locator('[data-testid="outline-row"] textarea').first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" x");
  await page.locator('[data-testid="outline-row"] textarea').first().blur();

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "unsaved");
  await expect(page.getByTestId("save-status")).toContainText("Storage full");
  await page.getByTestId("retry-save").click();
  await awaitSaved(page, baseline);
});
