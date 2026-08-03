import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("result")).toHaveAttribute("data-status", "passed");
  expect(externalRequests).toEqual([]);
});

test("IndexedDB repository passes persistence and restart corpus", async ({ page }) => {
  await expect(page.getByTestId("result")).toHaveAttribute("data-persistence", "true");
});

test("Web Worker adapter matches CorePort v1 golden contract", async ({ page }) => {
  await expect(page.getByTestId("result")).toHaveAttribute("data-core-port", "true");
});

test("IndexedDB fault injection preserves recoverable state", async ({ page }) => {
  await expect(page.getByTestId("result")).toHaveAttribute("data-recovery", "true");
});
