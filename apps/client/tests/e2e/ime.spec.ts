import { expect, test } from "@playwright/test";
import { blockTexts, createGraph, startOutline } from "./helpers";

// Korean (Hangul) composition: while a composition is active, Enter and
// other structural keys must not interrupt it, and the composed text is
// submitted to the core only at the composition boundary.
test("block commands never interrupt an active IME composition", async ({ page }) => {
  await createGraph(page, "IME Graph");
  await startOutline(page);

  await page.locator('[data-testid="outline-row"] textarea').first().evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const fire = (type: string, init: Record<string, unknown> = {}) => {
      const event =
        type === "keydown"
          ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
          : new CompositionEvent(type, { bubbles: true, cancelable: true, ...init });
      textarea.dispatchEvent(event);
    };
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, value);
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    };
    textarea.focus();
    fire("compositionstart");
    setValue("ㅎ");
    setValue("하");
    setValue("한");
    // An Enter that arrives mid-composition (keyCode 229) must be ignored.
    fire("keydown", { key: "Enter", keyCode: 229, isComposing: true });
    setValue("한그");
    setValue("한글");
    fire("compositionend", { data: "한글" });
  });

  // Composition stayed in one block: no split happened.
  await expect.poll(() => blockTexts(page)).toEqual(["한글"]);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  await expect(page.locator('[data-testid="outline-row"]')).toHaveCount(1);

  // After the boundary, Enter behaves structurally again.
  await page.locator('[data-testid="outline-row"] textarea').first().focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="outline-row"]')).toHaveCount(2);
});
