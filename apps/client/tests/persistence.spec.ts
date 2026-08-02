import { expect, test } from "@playwright/test";

test("Wasm fixture survives an IndexedDB and Worker restart", async ({ page }) => {
  await page.goto("/");
  const result = page.getByTestId("result");
  await expect(result).toHaveAttribute("data-status", "passed");
  const text = await result.textContent();
  expect(text).toContain("Statuspassed");

  const previousHash = await page.evaluate(() =>
    localStorage.getItem("neoseq-step-1-hash"),
  );
  expect(previousHash).toMatch(/^[a-f0-9]{64}$/);

  await page.reload();
  await expect(result).toHaveAttribute("data-status", "passed");
  const currentHash = await page.evaluate(() =>
    localStorage.getItem("neoseq-step-1-hash"),
  );
  expect(currentHash).toBe(previousHash);
});

