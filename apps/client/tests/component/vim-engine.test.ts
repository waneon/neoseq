import { describe, expect, it } from "vitest";
import {
  initialVimState,
  interpretVimKey,
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
