import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { awaitSaved, createGraph, startOutline } from "./helpers";

test("renders safe Markdown at rest and restores its source editor", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://example.com/")) {
      externalRequests.push(request.url());
    }
  });

  await createGraph(page, "Markdown Graph");
  await startOutline(page);
  const source = [
    "# Release note",
    "",
    "Read **bold text** with [source](https://example.com) and [unsafe](javascript:alert(1)).",
    "",
    "![diagram](https://example.com/tracker.png)",
  ].join("\n");
  await page.getByLabel("Block text").fill(source);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await awaitSaved(page);

  const projection = page.getByTestId("block-markdown");
  await expect(projection.getByRole("heading", { level: 2, name: "Release note" })).toBeVisible();
  await expect(projection.locator("strong")).toHaveText("bold text");
  await expect(projection.getByRole("link", { name: "source" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(projection.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  await expect(projection.locator("img")).toHaveCount(0);
  await expect(projection.locator(".markdown-image-alt")).toHaveText("diagram");
  expect(externalRequests).toEqual([]);
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    audit.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);

  await projection.getByRole("heading", { name: "Release note" }).click();
  const editor = page.getByLabel("Block text").first();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(source);
});
