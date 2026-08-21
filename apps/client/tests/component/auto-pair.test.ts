import { describe, expect, it } from "vitest";
import {
  planAutoPairInputRepair,
  planAutoPair,
  transformAutoClosers,
  type AutoCloserMarker,
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
      expect(plan!.autoCloser).toEqual({ opener, closer: expected[1], offset: 1 });
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
      autoCloser: { opener: "[", closer: "]", offset: 16 },
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
    expect(plan!.autoCloser?.offset).toBe(3);
  });
});

describe("auto closer provenance", () => {
  const squareCloser: AutoCloserMarker = { opener: "[", closer: "]", offset: 1 };

  it("tracks a closer while Korean composition grows before it", () => {
    expect(transformAutoClosers("[]", "[안녕]", [squareCloser])).toEqual([
      { opener: "[", closer: "]", offset: 3 },
    ]);
  });

  it("repairs an IME closer that is inserted before the tracked closer", () => {
    const marker = { ...squareCloser, offset: 3 };
    const repair = planAutoPairInputRepair("[안녕]", "[안녕]]", [marker], 3, 3);

    expect(repair).toEqual({
      from: 3,
      to: 4,
      insert: "",
      selectionStart: 4,
      selectionEnd: 4,
      selectionDirection: "none",
      autoCloser: { opener: "[", closer: "]", offset: 3 },
    });
    expect(apply("[안녕]]", repair!)).toBe("[안녕]");
  });

  it("repairs a closer delivered with the final Korean composition update", () => {
    const marker = { ...squareCloser, offset: 3 };
    const repair = planAutoPairInputRepair("[안녀]", "[안녕]]", [marker]);

    expect(repair).not.toBeNull();
    expect(apply("[안녕]]", repair!)).toBe("[안녕]");
  });

  it("does not remove repeated closers without auto-pair provenance", () => {
    expect(planAutoPairInputRepair("[안녕]", "[안녕]]", [])).toBeNull();
  });

  it("drops provenance when the generated closer itself is replaced", () => {
    expect(transformAutoClosers("[]", "[x", [squareCloser])).toEqual([]);
  });
});
