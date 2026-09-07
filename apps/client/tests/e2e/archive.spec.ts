import { test, expect } from "../support/fixtures";
import { fileURLToPath } from "node:url";

test("an exported graph imports as independent copies without changing its source", async ({
  app,
  page,
}, testInfo) => {
  await app.createGraph("Portable");
  await app.startBlock("Original note");
  await app.appendBlock("Nested note");
  await app.editors.last().click();
  await app.saved(() => page.keyboard.press("Tab"));
  const source = page.url();
  await page.goto("/");
  await page.getByRole("button", { name: "Actions for Portable" }).click();
  const downloading = page.waitForEvent("download");
  await page.getByTestId("export-graph-Portable").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Portable.neoseq");
  const archive = testInfo.outputPath("portable.neoseq");
  await download.saveAs(archive);
  const copies: string[] = [];
  for (const text of ["First independent copy", "Second independent copy"]) {
    await page.getByTestId("import-graph-file").setInputFiles(archive);
    await app.expectOutline(["Original note", "Nested note"]);
    await expect(app.block(1)).toHaveAttribute("aria-level", "2");
    copies.push(page.url());
    await app.editBlock(0, text);
    await page.reload();
    await app.expectOutline([text, "Nested note"]);
    await page.goto("/");
  }
  expect(new Set([source, ...copies]).size).toBe(3);
  await page.goto(source);
  await app.expectOutline(["Original note", "Nested note"]);
  await page.goto(copies[0]);
  await app.expectOutline(["First independent copy", "Nested note"]);
});

test("a corrupt archive reports failure without publishing a graph", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("import-graph-file").setInputFiles({
    name: "broken.neoseq",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not a graph archive"),
  });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("picker-empty")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("picker-empty")).toBeVisible();
  await expect(page.getByTestId("graph-list")).toHaveCount(0);
});

test("a supported legacy archive migrates into a durable independent graph", async ({
  app,
  page,
}) => {
  await page.goto("/");
  await page
    .getByTestId("import-graph-file")
    .setInputFiles(
      fileURLToPath(new URL("../../../../fixtures/graph-archive/schema-6.neoseq", import.meta.url)),
    );
  await expect(page.getByTestId("journal-title")).toBeVisible();
  expect(page.url()).not.toContain("schema-six-fixture");
  await page.getByRole("link", { name: "Schema six notes", exact: true }).click();
  await expect(page.getByTestId("page-title")).toHaveValue("Schema six notes");
  await expect(app.editors.last()).toHaveValue("Nested note");
  await app.editBlock(1, "Migrated note edited");
  await page.reload();
  await expect(app.editors.last()).toHaveValue("Migrated note edited");
  await expect(app.block(1)).toHaveAttribute("aria-level", "2");
});
