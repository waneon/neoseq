import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { awaitSaved, createGraph, openSettings, openSidebar, startOutline } from "./helpers";

async function openDiagnosticsSettings(page: Page): Promise<void> {
  await openSettings(page, "storage");
  await page.locator("details.settings-details > summary").click();
}

test("records a content-free artifact and keeps status visible across navigation", async ({
  page,
}, testInfo) => {
  const canary = "PRIVATE-DIAGNOSTIC-CANARY-DO-NOT-LEAK";
  await createGraph(page, "Diagnostic artifact");
  await openDiagnosticsSettings(page);
  await page.getByTestId("settings-start-diagnostics").click();
  await expect(page.getByRole("heading", { name: "Record diagnostic evidence" })).toBeVisible();
  await page.getByTestId("diagnostics-confirm-start").click();
  await expect(page.getByTestId("diagnostics-recording-status")).toBeVisible();

  await openSidebar(page);
  await page.getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await page.getByLabel("Block text").fill(canary);
  await page.getByLabel("Block text").blur();
  await awaitSaved(page);

  await openSidebar(page);
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "All graphs" }).click();
  await expect(page.getByRole("heading", { name: "Your graphs" })).toBeVisible();
  await expect(page.getByTestId("diagnostics-recording-status")).toBeVisible();
  await page.getByTestId("diagnostics-recording-status").click();

  await expect(page.getByRole("heading", { name: "Review diagnostic artifact" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("diagnostics-download").click();
  const download = await downloadPromise;
  const artifactPath = testInfo.outputPath("recording.neoseq-bug");
  await download.saveAs(artifactPath);
  const artifact = await readFile(artifactPath);
  expect(artifact.includes(Buffer.from(canary))).toBe(false);
  expect(artifact.includes(Buffer.from('"redaction_level": "standard"'))).toBe(true);
  expect(download.suggestedFilename()).toMatch(/\.neoseq-bug$/);
});

test("recovers an interrupted recording into review", async ({ page }) => {
  await createGraph(page, "Diagnostic recovery");
  await openDiagnosticsSettings(page);
  await page.getByTestId("settings-start-diagnostics").click();
  await page.getByTestId("diagnostics-confirm-start").click();
  await expect(page.getByTestId("diagnostics-recording-status")).toBeVisible();

  // The recorder checkpoints sanitized batches every 500 ms.
  await page.waitForTimeout(650);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Recovered diagnostic recording" })).toBeVisible();
  await expect(page.getByText("The last buffered events may be missing.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Discard recording" }).click();
  await expect(page.getByRole("heading", { name: "Recovered diagnostic recording" })).toBeHidden();
});
