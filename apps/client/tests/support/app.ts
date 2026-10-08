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

  /**
   * Performs a gesture, then waits until everything it started has settled and
   * the graph is saved locally. The application registers work synchronously
   * with the gesture that starts it and publishes `data-busy` on the document
   * while any is outstanding (src/lib/activity.ts), so this holds whether the
   * gesture saved once, several times, or not at all.
   */
  async saved(gesture?: () => Promise<unknown>): Promise<void> {
    await gesture?.();
    await this.settled();
    await expect(this.page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  }

  /** Waits until no application work is outstanding across two painted frames. */
  async settled(): Promise<void> {
    // Each evaluation waits in the page for the attribute to clear, so the
    // poll only repeats across navigations or unusually long work.
    await expect
      .poll(() => this.page.evaluate(settledWithin, 5_000), { intervals: [0] })
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

/** Runs in the page: resolves true once `data-busy` is absent across two frames. */
function settledWithin(budget: number): Promise<boolean> {
  const root = document.documentElement;
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, budget);
    const confirm = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (root.hasAttribute("data-busy")) return;
          clearTimeout(deadline);
          observer.disconnect();
          resolve(true);
        }),
      );
    const observer = new MutationObserver(() => {
      if (!root.hasAttribute("data-busy")) confirm();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-busy"] });
    if (!root.hasAttribute("data-busy")) confirm();
  });
}
