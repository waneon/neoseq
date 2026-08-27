import { afterEach, describe, expect, it, vi } from "vitest";
import { textareaCaretRect } from "../../src/ui/textarea-caret";

afterEach(() => {
  document.querySelector('[data-textarea-caret-mirror]')?.remove();
  vi.restoreAllMocks();
});

describe("textarea caret geometry", () => {
  it("translates the mirrored marker through the textarea viewport and scroll", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "prefix /command";
    textarea.style.fontSize = "16px";
    textarea.style.lineHeight = "20px";
    document.body.append(textarea);
    Object.defineProperties(textarea, {
      clientWidth: { value: 300 },
      offsetWidth: { value: 300 },
      offsetHeight: { value: 40 },
    });
    textarea.scrollLeft = 10;
    textarea.scrollTop = 5;
    textarea.getBoundingClientRect = () => new DOMRect(120, 200, 300, 40);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(64);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(18);

    expect(textareaCaretRect(textarea, 7)).toEqual(
      DOMRect.fromRect({ x: 174, y: 213, width: 1, height: 20 }),
    );

    textarea.remove();
  });
});
