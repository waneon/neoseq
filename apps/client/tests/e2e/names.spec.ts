import { expect, test } from "@playwright/test";
import { createGraph, createPage, openSidebar } from "./helpers";

test("live page names are unique and default names remain usable", async ({ page }) => {
  await createGraph(page, "Unique Names Graph");
  await createPage(page, "Alpha Page");

  await openSidebar(page);
  await page.getByTestId("new-page").click();
  const title = page.getByTestId("page-title");
  await expect(title).toHaveValue("Untitled");
  await title.fill("  alpha   page  ");
  await title.press("Enter");

  await expect(page.getByRole("alert")).toContainText("page name already exists");
  await expect(title).toHaveValue("Untitled");

  await openSidebar(page);
  await page.getByTestId("new-page").click();
  await expect(page.getByTestId("page-title")).toHaveValue("Untitled 2");
});
