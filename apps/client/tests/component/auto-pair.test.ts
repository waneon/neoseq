import { describe, expect, it } from "vitest";
import {
  planAutoPair,
  type AutoPairInput,
  type TextEditPlan,
} from "../../src/features/outline/auto-pair";

function request(overrides: Partial<AutoPairInput> = {}): AutoPairInput {
  return {
    value: "",
    start: 0,
    end: 0,
    direction: "none",
    inputType: "insertText",
    data: "(",
    isComposing: false,
    ...overrides,
  };
}

function apply(value: string, plan: TextEditPlan): string {
  return value.slice(0, plan.from) + plan.insert + value.slice(plan.to);
}

describe("auto pair planner", () => {
  it("inserts structural and symmetric pairs with the caret between them", () => {
    for (const [opener, expected] of [
      ["(", "()"],
      ["[", "[]"],
      ["{", "{}"],
      ['"', '""'],
      ["'", "''"],
      ["`", "``"],
    ]) {
      const plan = planAutoPair(request({ data: opener }));
      expect(plan).not.toBeNull();
      expect(apply("", plan!)).toBe(expected);
      expect([plan!.selectionStart, plan!.selectionEnd]).toEqual([1, 1]);
    }
  });

  it("wraps a selection and preserves its direction", () => {
    const plan = planAutoPair(request({
      value: "before selected after",
      start: 7,
      end: 15,
      direction: "backward",
      data: "[",
    }));

    expect(plan).toEqual({
      from: 7,
      to: 15,
      insert: "[selected]",
      selectionStart: 8,
      selectionEnd: 16,
      selectionDirection: "backward",
    });
    expect(apply("before selected after", plan!)).toBe("before [selected] after");
  });

  it("moves across an existing closer without changing text", () => {
    const plan = planAutoPair(request({ value: "()", start: 1, end: 1, data: ")" }));

    expect(plan).toEqual({
      from: 1,
      to: 1,
      insert: "",
      selectionStart: 2,
      selectionEnd: 2,
      selectionDirection: "none",
    });
    expect(apply("()", plan!)).toBe("()");
  });

  it("deletes both delimiters when backspacing inside an empty pair", () => {
    const plan = planAutoPair(request({
      value: "before [] after",
      start: 8,
      end: 8,
      inputType: "deleteContentBackward",
      data: null,
    }));

    expect(plan).not.toBeNull();
    expect(apply("before [] after", plan!)).toBe("before  after");
    expect(plan!.selectionStart).toBe(7);
  });

  it("leaves escaped delimiters and quotes beside words to ordinary input", () => {
    expect(planAutoPair(request({ value: "\\", start: 1, end: 1 }))).toBeNull();
    expect(planAutoPair(request({ value: "don", start: 3, end: 3, data: "'" }))).toBeNull();
    expect(planAutoPair(request({ value: "word", start: 4, end: 4, data: '"' }))).toBeNull();
    expect(planAutoPair(request({ value: "word", start: 0, end: 0, data: "`" }))).toBeNull();
  });

  it("ignores composition, paste, and multi-character replacements", () => {
    expect(planAutoPair(request({ isComposing: true }))).toBeNull();
    expect(planAutoPair(request({ inputType: "insertFromPaste" }))).toBeNull();
    expect(planAutoPair(request({ data: "()" }))).toBeNull();
  });

  it("keeps textarea UTF-16 offsets around non-BMP text", () => {
    const plan = planAutoPair(request({ value: "😀", start: 2, end: 2 }));

    expect(plan).not.toBeNull();
    expect(apply("😀", plan!)).toBe("😀()");
    expect(plan!.selectionStart).toBe(3);
  });
});
