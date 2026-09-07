import { test, expect } from "../support/fixtures";

// Adapter contracts deliberately use the instrumented build, not the E2E artifact.
for (const corpus of ["persistence", "core-port", "recovery", "sync"]) {
  test(`IndexedDB / Worker contract: ${corpus}`, async ({ page }) => {
    await page.goto(`/#/verify/storage?corpus=${corpus}`);
    const result = page.getByTestId("result");
    await expect(result).toHaveAttribute("data-corpus", corpus);
    await expect(result).toHaveAttribute("data-status", /^(passed|failed)$/);
    await expect(result).toHaveAttribute("data-status", "passed");
  });
}
