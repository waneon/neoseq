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

test("paired delimiters use native text input while compositions pass through", async ({ page }) => {
  await createGraph(page, "Pairing Graph");
  await startOutline(page);

  const textarea = page.locator('[data-testid="outline-row"] textarea').first();
  await textarea.focus();
  await page.keyboard.type("(");
  await expect(textarea).toHaveValue("()");
  await expect.poll(() => textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    return [input.selectionStart, input.selectionEnd];
  })).toEqual([1, 1]);

  await page.keyboard.type("x");
  await expect(textarea).toHaveValue("(x)");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(")");
  await expect(textarea).toHaveValue("()");
  await expect.poll(() => textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    return [input.selectionStart, input.selectionEnd];
  })).toEqual([2, 2]);

  await textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(1, 1);
  });
  await page.keyboard.press("Backspace");
  await expect(textarea).toHaveValue("");

  const compositionPrevented = await textarea.evaluate((element) => {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "(",
      inputType: "insertCompositionText",
      isComposing: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(compositionPrevented).toBe(false);

  await page.keyboard.type("[");
  await expect(textarea).toHaveValue("[]");
  await textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    const compose = (data: string, value: string, caret: number) => {
      input.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        data,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
      setValue.call(input, value);
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data,
        inputType: "insertCompositionText",
        isComposing: true,
      }));
    };

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    compose("안녕", "[안녕]", 3);
    compose("]", "[안녕]]", 4);
    input.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "]",
    }));
  });

  await expect(textarea).toHaveValue("[안녕]");
  await expect.poll(() => textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    return [input.selectionStart, input.selectionEnd];
  })).toEqual([4, 4]);
});
