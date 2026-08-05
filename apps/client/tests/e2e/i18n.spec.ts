import { expect, test } from "@playwright/test";
import { chooseFromMenu, createGraph, openSettings } from "./helpers";

test("switches to Korean immediately and restores it after reload", async ({ page }) => {
  await createGraph(page, "번역 그래프");
  await openSettings(page, "language");

  await chooseFromMenu(page, page.getByTestId("settings-language"), "한국어");
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("settings-language")).toContainText("한국어");

  // The open section lives in the URL, so a reload comes back to it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("settings-language")).toContainText("한국어");
});
