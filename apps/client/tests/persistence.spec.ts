import { expect, test } from "@playwright/test";

async function runCorpus(page: import("@playwright/test").Page, corpus: string) {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(request.url());
  });
  await page.goto(`/#/verify/storage?corpus=${corpus}`);
  await expect(page.getByTestId("result")).toHaveAttribute("data-status", "passed");
  await expect(page.getByTestId("result")).toHaveAttribute("data-corpus", corpus);
  expect(externalRequests).toEqual([]);
}

test("IndexedDB repository passes persistence and restart corpus", async ({ page }) => {
  await runCorpus(page, "persistence");
});

test("Web Worker adapter matches CorePort v1 golden contract", async ({ page }) => {
  await runCorpus(page, "core-port");
});

test("IndexedDB fault injection preserves recoverable state", async ({ page }) => {
  await runCorpus(page, "recovery");
});
