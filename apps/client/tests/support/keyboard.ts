import type { Page } from "@playwright/test";

/** The height a phone's keyboard takes from the visible viewport. */
export const KEYBOARD_HEIGHT = 300;

/**
 * Stands in for a phone's software keyboard, which an emulated browser lacks:
 * while a text field holds focus the visible viewport is shorter by the
 * keyboard and reports a resize, as on a device; the layout viewport is not.
 * Install before the page loads.
 */
export async function simulateSoftKeyboard(page: Page): Promise<void> {
  await page.addInitScript((height) => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let open = false;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - (open ? height : 0),
    });
    const textEntry = (element: Element | null) =>
      element instanceof HTMLElement &&
      (element.matches(
        "textarea, input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit])",
      ) ||
        element.isContentEditable);
    const sync = () => {
      const next = textEntry(document.activeElement);
      if (!next && pressing) return;
      if (next === open) return;
      open = next;
      viewport.dispatchEvent(new Event("resize"));
    };
    // A keyboard goes down once the tap that took focus away is over, so the
    // tap lands on what was under the finger when it began.
    let pressing = false;
    document.addEventListener("pointerdown", () => (pressing = true), true);
    for (const type of ["pointerup", "pointercancel"]) {
      document.addEventListener(
        type,
        () => {
          pressing = false;
          setTimeout(sync, 0);
        },
        true,
      );
    }
    document.addEventListener("focusin", sync, true);
    // Focus is on its way somewhere during focusout; read where it landed.
    document.addEventListener(
      "focusout",
      () => {
        if (!pressing) setTimeout(sync, 0);
      },
      true,
    );
  }, KEYBOARD_HEIGHT);
}

/** Whether the simulated keyboard is up: a text field holds focus. */
export function keyboardOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => window.visualViewport!.height < window.innerHeight);
}
