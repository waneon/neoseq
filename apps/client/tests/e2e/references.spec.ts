import { expect } from "@playwright/test";
import { test } from "../support/fixtures";

test("semantic links and typed properties keep one target through rename, deletion, and restore", async ({
  app,
  page,
}) => {
  await app.createGraph("Page references");
  await app.createPage("Roadmap");
  await app.startBlock("The original target");
  const targetURL = page.url();
  await app.createPage("Source");
  await app.startBlock("Semantic ");
  const semanticEditor = app.editors.first();
  await semanticEditor.click();
  await semanticEditor.press("End");
  await semanticEditor.pressSequentially("[[Road");
  await app.saved(() =>
    page
      .getByTestId("page-reference-menu")
      .getByRole("option", { name: "Roadmap", exact: true })
      .click(),
  );
  await expect(semanticEditor).toHaveValue("Semantic [[Roadmap]]");
  await app.appendBlock("Literal [[Roadmap]]");
  await expect(app.block(1).getByRole("link")).toHaveCount(0);

  // The same source links twice but contributes one backlink. A page property
  // is a second source; identical-looking uncompleted text contributes none.
  for (const owner of ["block", "page"]) {
    if (owner === "block") {
      await app.block(0).getByTestId("block-bullet").click({ button: "right" });
      await page.getByTestId("menu-properties").click();
    } else {
      await page.getByTestId("page-title").click({ button: "right" });
      await page.getByTestId("menu-page-properties").click();
    }
    const picker = page.getByTestId("property-picker");
    await picker.getByLabel("Property key").fill("related");
    await picker.getByRole("option", { name: "Create property “related”", exact: true }).click();
    await picker.getByRole("option", { name: "Page link", exact: true }).click();
    await picker.getByTestId("page-autocomplete").fill("Roadmap");
    await app.saved(() => page.getByRole("option", { name: "Roadmap", exact: true }).click());
    await expect(picker).toHaveCount(0);
  }

  await app.block(0).getByRole("link", { name: "[[Roadmap]]", exact: true }).click();
  await expect(page).toHaveURL(targetURL);
  await page.reload();
  const references = page.getByTestId("linked-references");
  await expect(references.getByTestId("linked-reference")).toHaveCount(2);
  await expect(references).toContainText("Semantic [[Roadmap]]");
  await expect(references).not.toContainText("Literal");

  const title = page.getByTestId("page-title");
  await title.fill("Launch plan");
  await title.press("Enter");
  await expect(references).toContainText("Semantic [[Launch plan]]");
  await expect(page).toHaveURL(targetURL);
  await references.getByRole("button", { name: "Open block", exact: true }).click();
  await expect(title).toHaveValue("Source");
  await app.expectOutline(["Semantic [[Launch plan]]", "Literal [[Roadmap]]"]);
  await app.block(0).getByRole("link", { name: "[[Launch plan]]", exact: true }).click();
  await expect(page).toHaveURL(targetURL);

  await title.click({ button: "right" });
  await page.getByTestId("delete-page").click();
  await app.saved(() => page.getByTestId("confirm-delete-page").click());
  await expect(page.getByTestId("tombstone")).toBeVisible();
  await page.goBack();
  await expect(title).toHaveValue("Source");
  await app
    .block(0)
    .getByRole("link", { name: /\[\[Launch plan\]\]/ })
    .click();
  await expect(page).toHaveURL(targetURL);
  await expect(page.getByTestId("tombstone")).toBeVisible();
  await app.saved(() => page.getByTestId("restore-page").click());
  await expect(title).toHaveValue("Launch plan");
  await app.expectOutline(["The original target"]);
  await page.reload();
  await expect(page).toHaveURL(targetURL);
  await expect(title).toHaveValue("Launch plan");
  await app.expectOutline(["The original target"]);
  await expect(references.getByTestId("linked-reference")).toHaveCount(2);
  await expect(references).not.toContainText("Literal");
});
