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
  const firstBlock = page.getByLabel("Block text");
  await expect(firstBlock).toBeVisible();
  // Reconciliation can paint the real row one microtask before the insertion
  // promise hands it the caret. Typing at "visible" in that gap sends keys to
  // the page instead of the editor, so wait for the user-facing postcondition.
  await expect(firstBlock).toBeFocused();
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

export async function awaitSaved(page: Page, afterSequence: string): Promise<void> {
  const status = page.getByTestId("save-status");
  // Leaving the old sequence proves that the mutation reached the session;
  // this may observe either its `saving` state or an already-finished save.
  await expect(status).not.toHaveAttribute("data-save-sequence", afterSequence);
  await expect(status).toHaveAttribute("data-save", "saved");
}

/** The durable revision to compare across one user gesture. */
export async function savedSequence(page: Page): Promise<string> {
  const status = page.getByTestId("save-status");
  await expect(status).toHaveAttribute("data-save", "saved");
  const sequence = await status.getAttribute("data-save-sequence");
  expect(sequence).not.toBeNull();
  return sequence!;
}

/** Runs one user mutation and proves that it reached a newer durable revision. */
export async function mutateAndAwaitSaved(
  page: Page,
  mutate: () => Promise<unknown>,
): Promise<void> {
  const before = await savedSequence(page);
  await mutate();
  await awaitSaved(page, before);
}

/** Types into the focused outline block and waits until the edit is durable. */
export async function typeInFocusedBlock(page: Page, text: string): Promise<void> {
  await mutateAndAwaitSaved(page, async () => {
    await page.keyboard.type(text);
    await page.locator('[data-testid="outline-row"] textarea:focus').blur();
  });
}

/** Inserts a query without racing its reconciled slash-menu row. */
export async function insertQueryBlock(
  page: Page,
  editor: Locator,
  opened: Locator,
): Promise<void> {
  await editor.click();
  await editor.press("End");
  await expect(editor).toBeFocused();
  const row = editor.locator("xpath=ancestor::*[@data-testid='outline-row']");
  await expect(row).toHaveAttribute("data-focused", "true");
  // Enter paints a temporary row synchronously and adopts the core's real id
  // when insertion reconciles. Slash commands on that transition have their
  // own product path, but query tests need a stable target whose subsequent
  // revision can be attributed to the query itself.
  await expect(row).not.toHaveAttribute("data-block-id", /^pending-/);
  const before = await savedSequence(page);
  // Adopting the real id can replace the optimistic textarea. Re-establish the
  // user's actual editing precondition after both identity and persistence are
  // quiet, not on the node they superseded.
  await editor.click();
  await editor.press("End");
  await expect(editor).toBeFocused();
  // The editor's debounce can reconcile the row during a Playwright round trip.
  // Observe the exact completed token and its active option in the browser, then
  // select in that same DOM commit. Watching only for the option is too early:
  // Query is already offered at `/q`, which would leave `uery` to be typed into
  // the block after it transforms.
  await Promise.all([
    editor.evaluate((textarea) => new Promise<void>((resolve) => {
      const choose = () => {
        const option = document.getElementById("slash-opt-query");
        if (
          textarea.value !== "/query"
          || textarea.getAttribute("aria-activedescendant") !== "slash-opt-query"
          || !(option instanceof HTMLButtonElement)
        ) return;
        observer.disconnect();
        option.click();
        resolve();
      };
      const observer = new MutationObserver(choose);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["aria-activedescendant"],
        childList: true,
        subtree: true,
      });
      choose();
    })),
    page.keyboard.type("/query"),
  ]);
  await expect(opened).toBeVisible();
  await awaitSaved(page, before);
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
  await mutateAndAwaitSaved(page, async () => {
    await titleInput.fill(title);
    await titleInput.press("Enter");
  });
  await expect(page.getByTestId("page-title")).toHaveValue(title);
}

/**
 * Picks a value from one of the product's dropdowns.
 *
 * Every field-like list of choices uses the same Radix Select, so the route is
 * a user's route: press the trigger, then press the option. This replaces
 * `selectOption`, which only ever worked against a native `<select>`.
 */
export async function chooseFromMenu(
  page: Page,
  trigger: Locator,
  option: string,
): Promise<void> {
  await trigger.click();
  const choice = page
    .getByRole("option", { name: option, exact: true })
    .or(page.getByRole("menuitemradio", { name: option, exact: true }));
  await expect(choice).toBeVisible();
  await choice.evaluate(async (element) => {
    const surface = element.closest('[role="menu"], [role="listbox"]') ?? element;
    await Promise.all(
      surface
        .getAnimations({ subtree: true })
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return timing !== undefined && Number.isFinite(timing.endTime ?? Infinity);
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await choice.click();
}

/** The page's verbs have no button: right-clicking its title row is the route. */
export async function openPageMenu(page: Page): Promise<void> {
  await page.getByTestId("page-title").click({ button: "right" });
  await awaitOpenedMenu(page);
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
  await awaitOpenedMenu(page);
}

/** A visible Radix menu is still moving during its entrance transition. */
async function awaitOpenedMenu(page: Page): Promise<void> {
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return timing !== undefined && Number.isFinite(timing.endTime ?? Infinity);
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
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
