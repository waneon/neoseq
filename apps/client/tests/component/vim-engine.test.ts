import { describe, expect, it } from "vitest";
import {
  initialVimState,
  interpretVimKey,
  wordEditsAcrossUnits,
  wordMotionAcrossUnits,
  type VimKey,
  type VimSnapshot,
  type VimState,
} from "../../src/features/blocks/editor/vim/engine";

const bare = (key: string, shift = false): VimKey => ({
  key,
  shift,
  alt: false,
  ctrl: false,
  meta: false,
});

const snapshot = (
  value: string,
  selectionStart = 0,
  editable = true,
): VimSnapshot => ({
  value,
  selectionStart,
  selectionEnd: selectionStart,
  editable,
});

function press(
  state: VimState,
  value: VimSnapshot,
  ...keys: string[]
) {
  let current = state;
  let last = interpretVimKey(current, value, bare(keys[0]));
  current = last.state;
  for (const key of keys.slice(1)) {
    last = interpretVimKey(current, value, bare(key));
    current = last.state;
  }
  return last;
}

describe("Vim key interpreter", () => {
  it("enters Insert at the requested side and returns to the prior grapheme", () => {
    const insert = interpretVimKey(initialVimState(), snapshot("한글", 0), bare("a"));
    expect(insert.state.mode).toBe("insert");
    expect(insert.effects).toEqual([{ kind: "selection", start: 1, end: 1 }]);

    const normal = interpretVimKey(insert.state, snapshot("한글", 2), bare("Escape"));
    expect(normal.state.mode).toBe("normal");
    expect(normal.effects).toEqual([{ kind: "selection", start: 1, end: 1 }]);
  });

  it("applies counts to motions without storing a second document cursor", () => {
    const counted = press(initialVimState(), snapshot("one two three"), "2", "w");
    expect(counted.effects).toEqual([{ kind: "selection", start: 8, end: 8 }]);
    expect(counted.state.count).toBe("");
  });

  it("composes delete and change operators with text motions", () => {
    const deleting = press(initialVimState(), snapshot("one two"), "d", "w");
    expect(deleting.state.mode).toBe("normal");
    expect(deleting.effects).toEqual([
      {
        kind: "edit",
        from: 0,
        to: 4,
        insert: "",
        selectionStart: 0,
        selectionEnd: 0,
      },
    ]);

    const changing = press(initialVimState(), snapshot("one two"), "c", "e");
    expect(changing.state.mode).toBe("insert");
    expect(changing.effects[0]).toMatchObject({ kind: "edit", from: 0, to: 3 });

    const toLineStart = press(initialVimState(), snapshot("one two", 4), "d", "0");
    expect(toLineStart.effects[0]).toMatchObject({ kind: "edit", from: 0, to: 4 });
  });

  it("composes delete and change operators with word text objects", () => {
    const pending = press(initialVimState(), snapshot("one  two three", 1), "d", "i");
    expect(pending.state).toMatchObject({
      mode: "operator-pending",
      operator: "delete",
      textObject: "inner",
    });
    expect(pending.effects).toEqual([]);

    expect(press(initialVimState(), snapshot("one  two three", 1), "d", "i", "w").effects)
      .toEqual([
        {
          kind: "edit",
          from: 0,
          to: 3,
          insert: "",
          selectionStart: 0,
          selectionEnd: 0,
        },
      ]);
    expect(press(initialVimState(), snapshot("one  two three", 1), "d", "a", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 0, to: 5 });

    const changing = press(initialVimState(), snapshot("one  two three", 6), "c", "i", "w");
    expect(changing.state.mode).toBe("insert");
    expect(changing.effects[0]).toMatchObject({
      kind: "edit",
      from: 5,
      to: 8,
      selectionStart: 5,
    });
  });

  it("matches Vim word-object whitespace and count semantics", () => {
    expect(press(initialVimState(), snapshot("one  two three", 3), "d", "i", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 3, to: 5 });
    expect(press(initialVimState(), snapshot("one  two three", 3), "d", "a", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 3, to: 8 });
    expect(press(initialVimState(), snapshot("one  two three", 0), "2", "d", "i", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 0, to: 5 });
    expect(press(initialVimState(), snapshot("one  two three", 0), "d", "2", "a", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 0, to: 9 });
    expect(press(initialVimState(), snapshot("one  ", 3), "d", "a", "w").effects)
      .toEqual([]);
    expect(press(initialVimState(), snapshot("one two", 0), "3", "d", "a", "w").effects)
      .toEqual([]);
  });

  it("delegates outline word motions and operators to one structural text stream", () => {
    const outline = { ...snapshot("one", 0), supportsCrossBlockWords: true };
    expect(interpretVimKey(initialVimState(), outline, bare("w")).effects).toEqual([
      {
        kind: "surface",
        command: {
          type: "word-motion",
          motion: "w",
          count: 1,
          caret: 0,
          operator: null,
        },
      },
    ]);
    expect(press(initialVimState(), outline, "d", "w").effects).toEqual([
      {
        kind: "surface",
        command: {
          type: "word-motion",
          motion: "w",
          count: 1,
          caret: 0,
          operator: "delete",
        },
      },
    ]);
    expect(press(initialVimState(), outline, "c", "w").state.mode).toBe("insert");
    expect(press(initialVimState(), outline, "d", "i", "w").effects[0])
      .toMatchObject({ kind: "edit", from: 0, to: 3 });

    const values = ["one tail", "next words", "last"];
    expect(wordMotionAcrossUnits(values, { unit: 0, offset: 4 }, "w", 2))
      .toEqual({ unit: 1, offset: 5 });
    expect(wordMotionAcrossUnits(values, { unit: 1, offset: 0 }, "b", 1))
      .toEqual({ unit: 0, offset: 4 });
    expect(wordMotionAcrossUnits(values, { unit: 0, offset: 7 }, "e", 1))
      .toEqual({ unit: 1, offset: 3 });
    expect(wordMotionAcrossUnits([" a b"], { unit: 0, offset: 0 }, "e", 1))
      .toEqual({ unit: 0, offset: 1 });
    expect(wordEditsAcrossUnits(values, { unit: 0, offset: 4 }, "w", 2)).toEqual({
      caret: { unit: 0, offset: 4 },
      edits: [
        { unit: 0, from: 4, to: 8 },
        { unit: 1, from: 0, to: 5 },
      ],
    });
    expect(wordEditsAcrossUnits(values, { unit: 1, offset: 0 }, "b", 1)).toEqual({
      caret: { unit: 0, offset: 4 },
      edits: [{ unit: 0, from: 4, to: 8 }],
    });
  });

  it("keeps vertical motion inside multiline text and emits an intent at a boundary", () => {
    const inside = interpretVimKey(
      initialVimState(),
      snapshot("abcd\nxy", 3),
      bare("j"),
    );
    expect(inside.effects).toEqual([{ kind: "selection", start: 6, end: 6 }]);
    expect(inside.state.desiredColumn).toBe(3);

    const boundary = interpretVimKey(inside.state, snapshot("abcd\nxy", 6), bare("j"));
    expect(boundary.effects).toEqual([
      {
        kind: "surface",
        command: { type: "focus", direction: 1, count: 1, column: 3 },
      },
    ]);
  });

  it("emits outline intents for linewise and structural commands", () => {
    expect(press(initialVimState(), snapshot("one"), "d", "d").effects).toEqual([
      { kind: "surface", command: { type: "delete-unit", count: 1 } },
    ]);
    expect(press(initialVimState(), snapshot("one"), ">", ">").effects).toEqual([
      { kind: "surface", command: { type: "indent", count: 1 } },
    ]);
    expect(interpretVimKey(initialVimState(), snapshot("one"), bare("O")).effects)
      .toEqual([{ kind: "surface", command: { type: "open", side: "before" } }]);
  });

  it("keeps Visual Line structural and capability-gated", () => {
    const unsupported = interpretVimKey(initialVimState(), snapshot("one"), bare("V", true));
    expect(unsupported.state.mode).toBe("normal");
    expect(unsupported.effects).toEqual([]);

    const supported = { ...snapshot("one", 2), supportsVisualLine: true };
    const counted = press(initialVimState(), supported, "3", "V");
    expect(counted.state.mode).toBe("visual-line");
    expect(counted.effects).toEqual([
      {
        kind: "surface",
        command: {
          type: "visual-line",
          action: "begin",
          count: 3,
          caret: 2,
          column: 2,
        },
      },
    ]);

    const moved = press(counted.state, supported, "2", "j");
    expect(moved.state.mode).toBe("visual-line");
    expect(moved.effects).toEqual([
      {
        kind: "surface",
        command: { type: "visual-line", action: "move", direction: 1, count: 2 },
      },
    ]);

    const deleted = interpretVimKey(moved.state, supported, bare("d"));
    expect(deleted.state.mode).toBe("normal");
    expect(deleted.effects).toEqual([
      { kind: "surface", command: { type: "visual-line", action: "delete" } },
    ]);
  });

  it("does not expose editing effects from a read-only surface", () => {
    const deleting = press(initialVimState(), snapshot("one", 0, false), "d", "w");
    expect(deleting.handled).toBe(true);
    expect(deleting.effects).toEqual([]);
    expect(deleting.state.mode).toBe("normal");
  });

  it("passes modifier shortcuts through except for Vim redo", () => {
    const command = interpretVimKey(initialVimState(), snapshot("one"), {
      ...bare("p"),
      meta: true,
    });
    expect(command.handled).toBe(false);

    const redo = interpretVimKey(initialVimState(), snapshot("one"), {
      ...bare("r"),
      ctrl: true,
    });
    expect(redo.effects).toEqual([
      { kind: "surface", command: { type: "history", redo: true } },
    ]);

    expect(interpretVimKey(initialVimState(), snapshot("one"), bare("F10", true)).handled)
      .toBe(false);
  });
});
