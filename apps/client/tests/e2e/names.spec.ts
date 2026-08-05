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

  // The refusal is a report now: the field snapping back is the only other thing
  // the user would see, and on its own it reads as a keystroke that did nothing.
  const report = page.getByRole("alert");
  await expect(report).toContainText("Couldn’t rename this page");
  await expect(report).toContainText("A page with that name already exists.");
  await expect(title).toHaveValue("Untitled");

  await openSidebar(page);
  await page.getByTestId("new-page").click();
  await expect(page.getByTestId("page-title")).toHaveValue("Untitled 2");
});
