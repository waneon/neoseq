import { expect } from "@playwright/test";
import { test } from "../support/fixtures";

test("page and tag conversion preserves the document, its blocks, references, and old routes", async ({
  app,
  page,
}) => {
  await app.createGraph("Unified documents");
  await app.createPage("env");
  await app.startBlock("Environment notes");
  const originalURL = page.url();
  const blockId = await app.block(0).getAttribute("data-block-id");
  await page.getByTestId("page-actions-trigger").click();
  await app.saved(() => page.getByTestId("convert-to-tag").click());
  await expect(page.getByTestId("tag-title")).toHaveValue("env");
  const tagURL = page.url();
  expect(tagURL).toBe(originalURL.replace("/p/", "/t/"));
  await app.expectOutline(["Environment notes"]);
  expect(await app.block(0).getAttribute("data-block-id")).toBe(blockId);
  await app.createPage("Source");
  await app.startBlock("Uses ");
  const editor = app.editors.first();
  await editor.click();
  await editor.press("End");
  await editor.pressSequentially("[[env");
  await app.saved(() =>
    page
      .getByTestId("page-reference-menu")
      .getByRole("option", { name: "env", exact: true })
      .click(),
  );
  await editor.blur();
  await app.block(0).getByRole("link", { name: "[[env]]", exact: true }).click();
  await expect(page).toHaveURL(tagURL);
  await expect(page.getByTestId("linked-reference")).toHaveCount(1);
  await page.getByTestId("tag-actions-trigger").click();
  await app.saved(() => page.getByTestId("convert-to-page").click());
  await expect(page).toHaveURL(originalURL);
  await app.expectOutline(["Environment notes"]);
  expect(await app.block(0).getAttribute("data-block-id")).toBe(blockId);
  await page.goto(tagURL);
  await expect(page).toHaveURL(originalURL);
  await app.expectOutline(["Environment notes"]);
  await expect(page.getByTestId("linked-reference")).toHaveCount(1);
});

test("hash completion explicitly converts an existing page and keeps membership after converting back", async ({
  app,
  page,
}) => {
  await app.createGraph("Tag conversion completion");
  await app.createPage("env");
  await app.startBlock("Preserved body");
  const targetURL = page.url();
  await app.createPage("Notes");
  const sourceURL = page.url();
  await app.startBlock("Shell ");
  const editor = app.editors.first();
  await editor.click();
  await editor.press("End");
  await editor.pressSequentially("#env");
  await app.saved(() =>
    page
      .getByTestId("tag-menu")
      .getByRole("option", { name: "Convert “env” to a tag and apply" })
      .click(),
  );
  await editor.blur();
  await expect(app.block(0).getByTestId("tag-chip")).toContainText("env");
  await page.goto(targetURL);
  await expect(page.getByTestId("tag-title")).toHaveValue("env");
  await app.expectOutline(["Preserved body"]);
  await page.getByTestId("tag-actions-trigger").click();
  await app.saved(() => page.getByTestId("convert-to-page").click());
  await expect(page).toHaveURL(targetURL);
  await page.goto(sourceURL);
  await expect(app.block(0).getByTestId("tag-chip")).toContainText("env");
  await expect(app.block(0).getByTestId("tag-chip")).not.toHaveAttribute("data-tombstone");
  await app.block(0).getByTestId("tag-chip").click();
  await expect(page).toHaveURL(targetURL);
  await app.expectOutline(["Preserved body"]);
});
