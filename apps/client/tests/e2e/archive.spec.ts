import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { blockTexts, createGraph, startOutline, typeInFocusedBlock } from "./helpers";

test("imports every archive copy under a fresh graph identity", async ({ page }) => {
  await createGraph(page, "Archive source");
  await startOutline(page);
  await typeInFocusedBlock(page, "portable note");
  const sourceGraphId = graphId(page.url());

  await page.goto("/");
  await page.getByRole("button", { name: "Actions for Archive source" }).click();
  const downloadStarted = page.waitForEvent("download");
  await page.getByTestId("export-graph-Archive source").click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("Archive source.neoseq");
  const archivePath = await download.path();
  if (!archivePath) throw new Error("the graph archive download has no local path");

  const firstImport = page.waitForEvent("filechooser");
  await page.getByTestId("import-graph").click();
  await (await firstImport).setFiles(archivePath);
  await expect(page.getByTestId("journal-title")).toBeVisible();
  const firstImportedGraphId = graphId(page.url());
  expect(firstImportedGraphId).not.toBe(sourceGraphId);
  await expect.poll(() => blockTexts(page)).toEqual(["portable note"]);

  await page.goto("/");
  const secondImport = page.waitForEvent("filechooser");
  await page.getByTestId("import-graph").click();
  await (await secondImport).setFiles(archivePath);
  await expect(page.getByTestId("journal-title")).toBeVisible();
  const secondImportedGraphId = graphId(page.url());
  expect(secondImportedGraphId).not.toBe(sourceGraphId);
  expect(secondImportedGraphId).not.toBe(firstImportedGraphId);
  await expect.poll(() => blockTexts(page)).toEqual(["portable note"]);

  await page.goto("/");
  await expect(page.getByTestId("open-graph-Archive source")).toHaveCount(3);
});

function graphId(url: string): string {
  const parsed = new URL(url);
  const route = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : parsed.pathname;
  const match = route.match(/^\/g\/([^/]+)/u);
  if (!match) throw new Error(`expected a graph route, received ${url}`);
  return decodeURIComponent(match[1]);
}

test("migrates a schema 6 archive before installing a durable graph copy", async ({ page }) => {
  await page.goto("/");
  const chooseArchive = page.waitForEvent("filechooser");
  await page.getByTestId("import-graph").click();
  await (
    await chooseArchive
  ).setFiles(
    fileURLToPath(new URL("../../../../fixtures/graph-archive/schema-6.neoseq", import.meta.url)),
  );
  await expect(page.getByTestId("journal-title")).toBeVisible();
  expect(graphId(page.url())).not.toBe("schema-six-fixture");
  await page.getByRole("link", { name: "Schema six notes", exact: true }).click();
  await expect(page.getByTestId("page-title")).toHaveValue("Schema six notes");
  await expect.poll(() => blockTexts(page)).toContain("Nested note");
  await page.reload();
  await expect(page.getByTestId("page-title")).toHaveValue("Schema six notes");
  await expect.poll(() => blockTexts(page)).toContain("Nested note");
});
