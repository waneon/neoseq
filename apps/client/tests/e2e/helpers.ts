import { expect, type Page } from "@playwright/test";

/** Creates a fresh local graph and lands on today's journal. */
export async function createGraph(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-graph-name").fill(name);
  await page.getByTestId("create-graph").click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
}

export async function startOutline(page: Page): Promise<void> {
  await page.getByTestId("outline-start").click();
  await expect(page.getByLabel("Block text")).toBeVisible();
}

export function blockTexts(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="outline-row"] textarea')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLTextAreaElement).value));
}

export function blockLevels(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="outline-row"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-level") ?? ""));
}

export async function awaitSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
}

/** Types into the focused outline block and waits until the edit is durable. */
export async function typeInFocusedBlock(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
  await page.locator('[data-testid="outline-row"] textarea:focus').blur();
  await awaitSaved(page);
}

/** Opens the off-canvas sidebar when the mobile layout is active. */
export async function openSidebar(page: Page): Promise<void> {
  const toggle = page.locator(".shell-toggle");
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.getByTestId("sidebar")).toHaveAttribute("data-open", "true");
  }
}

/** Creates a named page via the sidebar and lands on it. */
export async function createPage(page: Page, title: string): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("new-page").click();
  const titleInput = page.getByTestId("page-title");
  await expect(titleInput).toHaveValue("Untitled");
  await titleInput.fill(title);
  await titleInput.press("Enter");
  await expect(page.getByTestId("page-title")).toHaveValue(title);
  await awaitSaved(page);
}

/**
 * Opens the page-properties panel the way a user does. Properties are behind a
 * disclosure now — the writing surface carries no database chrome at rest — and
 * the page ⋯ menu is their always-visible route in.
 */
export async function openPageProperties(page: Page): Promise<void> {
  await page.getByTestId("page-menu").click();
  await page.getByTestId("menu-page-properties").click();
  await expect(page.getByTestId("props-panel")).toBeVisible();
}

/** The tagged-block defaults live one level deeper, behind Advanced. */
export async function openDefaults(page: Page): Promise<void> {
  await openPageProperties(page);
  await page.getByTestId("props-defaults-toggle").click();
  await expect(page.getByTestId("props-defaults")).toBeVisible();
}

export async function openBlockInspector(page: Page, index = 0): Promise<void> {
  await page.getByTestId("block-menu").nth(index).click();
  await page.getByTestId("menu-properties").click();
  await expect(page.getByTestId("block-inspector")).toBeVisible();
}
