import { expect, type Locator, type Page } from "@playwright/test";

/** Shared user gestures; each scenario owns its expected data. */
export class NeoseqApp {
  constructor(readonly page: Page) {}

  get rows(): Locator {
    return this.page.getByTestId("outline-row");
  }
  get editors(): Locator {
    return this.rows.getByRole("textbox", { name: "Block text", exact: true, includeHidden: true });
  }
  block(index: number): Locator {
    return this.rows.nth(index);
  }

  async createGraph(name: string): Promise<void> {
    await this.page.goto("/");
    await this.page.getByTestId("new-graph").click();
    await this.page.getByTestId("new-graph-name").fill(name);
    await this.page.getByTestId("create-graph").click();
    await expect(this.page.getByTestId("journal-title")).toBeVisible();
    await expect(this.page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  }

  async sidebar(): Promise<void> {
    const toggle = this.page.locator(".shell-toggle");
    if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await expect(this.page.getByTestId("sidebar")).toBeVisible();
  }

  async createPage(title: string): Promise<void> {
    await this.sidebar();
    await this.page.getByTestId("new-page").click();
    const input = this.page.getByTestId("page-title");
    await expect(input).toHaveValue("Untitled");
    await this.saved(async () => {
      await input.fill(title);
      await input.press("Enter");
    });
    await expect(input).toHaveValue(title);
  }

  async settings(section = "appearance"): Promise<void> {
    await this.sidebar();
    await this.page.getByTestId("open-settings").click();
    await expect(this.page.getByTestId("settings-dialog")).toBeVisible();
    await this.page.getByTestId(`settings-tab-${section}`).click();
  }

  /** Only for gestures guaranteed to change data; capture BEFORE the input. */
  async saved(gesture: () => Promise<unknown>): Promise<void> {
    const status = this.page.getByTestId("save-status");
    await expect(status).toHaveAttribute("data-save", "saved");
    const before = await status.getAttribute("data-save-sequence");
    expect(before).not.toBeNull();
    await gesture();
    // Read state and revision together: the revision is absent during saving.
    await expect
      .poll(() =>
        status.evaluate(
          (node, previous) =>
            node.getAttribute("data-save") === "saved" &&
            node.getAttribute("data-save-sequence") !== null &&
            node.getAttribute("data-save-sequence") !== previous,
          before,
        ),
      )
      .toBe(true);
  }

  async startBlock(text: string): Promise<void> {
    await this.saved(() => this.page.getByTestId("outline-start").click());
    await expect(this.editors.first()).toBeFocused();
    if (text) await this.editBlock(0, text);
  }

  async appendBlock(text: string): Promise<void> {
    const count = await this.rows.count();
    const last = this.editors.last();
    const preview = this.rows.last().getByTestId("block-markdown");
    if (await preview.isVisible()) await preview.click();
    await last.click();
    await last.press("ControlOrMeta+a");
    await last.press("ArrowRight");
    await this.saved(() => last.press("Enter"));
    await expect(this.rows).toHaveCount(count + 1);
    await expect(this.editors.last()).toBeFocused();
    if (text) await this.editBlock(count, text);
  }

  async editBlock(index: number, text: string): Promise<void> {
    const editor = this.editors.nth(index);
    await this.saved(async () => {
      const preview = this.block(index).getByTestId("block-markdown");
      if (await preview.isVisible()) await preview.click();
      await editor.fill(text);
      await editor.blur();
    });
    await expect(editor).toHaveValue(text);
    await expect(this.block(index)).not.toHaveAttribute("data-focused", "true");
  }

  async expectOutline(texts: string[]): Promise<void> {
    await expect
      .poll(() =>
        this.editors.evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLTextAreaElement).value),
        ),
      )
      .toEqual(texts);
  }

  async offlineReady(): Promise<void> {
    await this.page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
            once: true,
          }),
        );
      }
    });
  }
}
