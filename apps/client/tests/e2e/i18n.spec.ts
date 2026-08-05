import { expect, test } from "@playwright/test";
import { createGraph, openSidebar } from "./helpers";

test("switches to Korean immediately and restores it after reload", async ({ page }) => {
  await createGraph(page, "번역 그래프");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Settings" }).click();

  await page.getByTestId("settings-language").selectOption("ko");
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("settings-language")).toHaveValue("ko");

  await page.reload();
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByTestId("settings-language")).toHaveValue("ko");
});
