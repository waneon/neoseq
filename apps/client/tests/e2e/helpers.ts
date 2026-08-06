import { expect, type Locator, type Page } from "@playwright/test";
import type { SettingsSection } from "../../src/features/settings/SettingsDialog";

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
 * Picks a value from one of the product's dropdowns.
 *
 * Every list of choices — a language, a journal date format, a property type, a
 * task status — is the same Radix menu the bullet's context menu is
 * (DESIGN.md § Components / Choice), so the route is a user's route: press the
 * trigger, then press the option. This replaces `selectOption`, which only ever
 * worked against a native `<select>`.
 */
export async function chooseFromMenu(
  page: Page,
  trigger: Locator,
  option: string,
): Promise<void> {
  await trigger.click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}

/** The page's verbs have no button: right-clicking its title row is the route. */
export async function openPageMenu(page: Page): Promise<void> {
  await page.getByTestId("page-title").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
}

/**
 * Opens the page-properties panel the way a user does. Properties are behind a
 * disclosure — the writing surface carries no database chrome at rest — and the
 * title row's context menu is their route in.
 */
export async function openPageProperties(page: Page): Promise<void> {
  await openPageMenu(page);
  await page.getByTestId("menu-page-properties").click();
  await expect(page.getByTestId("property-picker")).toBeVisible();
}

/** A block's verbs live on its bullet, which is also its drag handle. */
export async function openBlockMenu(page: Page, index = 0): Promise<void> {
  await page.getByTestId("block-bullet").nth(index).click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
}

/** The tagged-block defaults live one level deeper, behind Advanced. */
export async function openBlockProperties(page: Page, index = 0): Promise<void> {
  await openBlockMenu(page, index);
  await page.getByTestId("menu-properties").click();
  await expect(page.getByTestId("property-picker")).toBeVisible();
}

export async function openBlockTags(page: Page, index = 0): Promise<void> {
  await openBlockMenu(page, index);
  await page.getByTestId("menu-tags").click();
  await expect(page.getByTestId("tag-picker")).toBeVisible();
}

/**
 * Opens the settings dialog from its one permanent route, the rail footer, and
 * lands on a section. The section is part of the URL, so a reload comes back to
 * the same place.
 */
export async function openSettings(
  page: Page,
  section: SettingsSection = "appearance",
): Promise<void> {
  await openSidebar(page);
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  if (section !== "appearance") await page.getByTestId(`settings-tab-${section}`).click();
}
