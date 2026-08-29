import { expect, test } from "@playwright/test";
import { createGraph } from "./helpers";

test("reduced motion settles interactive surfaces without visible travel", async ({ page }) => {
  await createGraph(page, "Reduced Motion Graph");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );

  await page.getByTestId("open-palette").click();
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  const longest = await palette.evaluate((element) =>
    Math.max(
      0,
      ...element.getAnimations({ subtree: true }).map((animation) => {
        const duration = animation.effect?.getComputedTiming().duration;
        return typeof duration === "number" ? duration : 0;
      }),
    ),
  );
  expect(longest).toBeLessThanOrEqual(1);
});
