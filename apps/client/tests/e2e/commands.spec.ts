import { expect, test } from "@playwright/test";
import { createGraph, openSidebar } from "./helpers";

test("contextual commands explain why they are unavailable instead of no-oping", async ({
  page,
}) => {
  await createGraph(page, "Command Context Graph");
  await openSidebar(page);
  await page.getByTestId("nav-tags").click();
  await expect(page.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();

  await page.getByTestId("open-palette").click();
  const palette = page.getByTestId("command-palette");
  for (const id of ["properties", "set-status", "set-priority", "page-info", "delete-page"]) {
    await expect(palette.getByTestId(`cmd-${id}`)).toHaveAttribute("aria-disabled", "true");
  }
  await expect(palette.getByTestId("cmd-properties")).toContainText(
    "Open a page or focus one block",
  );
  await expect(palette).toBeVisible();
});
