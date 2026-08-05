// Toasts against the real Wasm core: a genuine rejection, the surface it
// raises, and the thing a fixed region must never do — sit in front of the
// chrome it is reporting on.

import { expect, test, type Page } from "@playwright/test";
import { createGraph, openSidebar, startOutline, typeInFocusedBlock } from "./helpers";

/** Tab on the first root block: the core rejects it, so a toast must appear. */
async function provokeRejection(page: Page): Promise<void> {
  await page.getByLabel("Block text").first().click();
  await page.keyboard.press("Tab");
}

test("a rejected command is reported instead of doing nothing", async ({ page }) => {
  await createGraph(page, "Toast Graph");
  await startOutline(page);
  await typeInFocusedBlock(page, "first");
  await provokeRejection(page);

  const toast = page.getByTestId("toast");
  await expect(toast).toHaveAttribute("data-tone", "danger");
  await expect(toast).toHaveText(/Couldn’t indent that block/);
  await expect(toast).toHaveText(/First sibling cannot be indented\./);
  // Every report expires, and shows how long it has left while it does.
  await expect(page.getByTestId("toast-timer")).toBeVisible();
  await expect(toast).toHaveAttribute("data-paused", "false");

  // Hovering holds the countdown, so reading one can never cost you it.
  await toast.hover();
  await expect(toast).toHaveAttribute("data-paused", "true");
  await page.waitForTimeout(1500);
  await expect(toast).toBeVisible();

  // The dismiss button is not summoned: it is there from the moment the toast is.
  await page.getByTestId("toast-dismiss").click();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

test("repeats collapse onto one toast rather than stacking", async ({ page }) => {
  await createGraph(page, "Toast Repeat");
  await startOutline(page);
  await typeInFocusedBlock(page, "first");
  await provokeRejection(page);
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await provokeRejection(page);
  await expect(page.getByTestId("toast")).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveText(/×2/);
});

test("the region never stands between the pointer and the interface", async ({ page }) => {
  await createGraph(page, "Toast Hit Test");
  const region = page.getByTestId("toasts");
  await expect(region).toHaveCSS("pointer-events", "none");

  await startOutline(page);
  await typeInFocusedBlock(page, "first");
  await provokeRejection(page);
  await expect(page.getByTestId("toast")).toBeVisible();
  // The toast is up; the top bar it sits below is still reachable, and the
  // toast itself takes the pointer where it actually is.
  await expect(page.getByTestId("toast")).toHaveCSS("pointer-events", "auto");
  // …and the interface underneath is still operable while it is up. At drawer
  // widths the rail is off-canvas, so reaching Search means opening it first —
  // which is itself a click the region must not have swallowed.
  await openSidebar(page);
  await page.getByTestId("open-palette").click();
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("journal-title")).toBeVisible();
});
