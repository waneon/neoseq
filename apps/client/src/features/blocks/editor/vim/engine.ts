// A small, surface-neutral Vim grammar for Neoseq block text.
//
// The engine knows strings, insertion offsets, modes, counts and operators. It
// does not know React, textarea DOM, outline trees or query rows. Structural
// commands leave as intents so each editing surface can preserve its own rules.

export type VimMode = "normal" | "insert" | "operator-pending";
export type VimOperator = "delete" | "change" | "indent" | "outdent";

export interface VimState {
  mode: VimMode;
  count: string;
  operator: VimOperator | null;
  operatorCount: number;
  prefix: "g" | null;
  /** Logical column retained across vertical motion. */
  desiredColumn: number | null;
}

export interface VimSnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  editable: boolean;
}

export interface VimKey {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export type VimSurfaceCommand =
  | { type: "focus"; direction: -1 | 1; count: number; column: number }
  | { type: "focus-edge"; edge: "first" | "last" }
  | { type: "open"; side: "before" | "after" }
  | { type: "delete-unit"; count: number }
  | { type: "indent"; count: number }
  | { type: "outdent"; count: number }
  | { type: "history"; redo: boolean };

export type VimEffect =
  | { kind: "selection"; start: number; end: number }
  | {
      kind: "edit";
      from: number;
      to: number;
      insert: string;
      selectionStart: number;
      selectionEnd: number;
    }
  | { kind: "surface"; command: VimSurfaceCommand };

export interface VimInterpretation {
  handled: boolean;
  state: VimState;
  effects: VimEffect[];
}

export function initialVimState(mode: VimMode = "normal"): VimState {
  return {
    mode,
    count: "",
    operator: null,
    operatorCount: 1,
    prefix: null,
    desiredColumn: null,
  };
}

function normalState(desiredColumn: number | null = null): VimState {
  return { ...initialVimState(), desiredColumn };
}

function result(state: VimState, effects: VimEffect[] = []): VimInterpretation {
  return { handled: true, state, effects };
}

function pass(state: VimState): VimInterpretation {
  return { handled: false, state, effects: [] };
}

function parsedCount(value: string): number {
  if (!value) return 1;
  return Math.max(1, Math.min(Number.parseInt(value, 10), 9999));
}

function appendCount(state: VimState, digit: string): VimState {
  return { ...state, count: `${state.count}${digit}`.slice(0, 4) };
}

function graphemeBoundaries(value: string): number[] {
  const starts: number[] = [0];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const segment of segmenter.segment(value)) {
      if (segment.index > 0) starts.push(segment.index);
    }
  } else {
    let offset = 0;
    for (const point of value) {
      offset += point.length;
      if (offset < value.length) starts.push(offset);
    }
  }
  if (starts[starts.length - 1] !== value.length) starts.push(value.length);
  return starts;
}

function previousBoundary(value: string, position: number): number {
  const clamped = Math.max(0, Math.min(position, value.length));
  const boundaries = graphemeBoundaries(value);
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if (boundaries[index] < clamped) return boundaries[index];
  }
  return 0;
}

function nextBoundary(value: string, position: number): number {
  const clamped = Math.max(0, Math.min(position, value.length));
  for (const boundary of graphemeBoundaries(value)) {
    if (boundary > clamped) return boundary;
  }
  return value.length;
}

function lineStart(value: string, position: number): number {
  return value.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
}

function lineEnd(value: string, position: number): number {
  const newline = value.indexOf("\n", Math.max(0, position));
  return newline < 0 ? value.length : newline;
}

function normalLineEnd(value: string, position: number): number {
  const start = lineStart(value, position);
  const end = lineEnd(value, position);
  return end > start ? previousBoundary(value, end) : start;
}

function firstNonBlank(value: string, position: number): number {
  const start = lineStart(value, position);
  const end = lineEnd(value, position);
  let cursor = start;
  while (cursor < end) {
    const next = nextBoundary(value, cursor);
    if (!/^\s$/u.test(value.slice(cursor, next))) return cursor;
    cursor = next;
  }
  return start;
}

type WordClass = "space" | "word" | "punctuation";

function wordClass(grapheme: string): WordClass {
  if (/^\s+$/u.test(grapheme)) return "space";
  if (/^[\p{L}\p{N}\p{M}_]+$/u.test(grapheme)) return "word";
  return "punctuation";
}

interface Grapheme {
  start: number;
  end: number;
  kind: WordClass;
}

function graphemes(value: string): Grapheme[] {
  const boundaries = graphemeBoundaries(value);
  const result: Grapheme[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    result.push({ start, end, kind: wordClass(value.slice(start, end)) });
  }
  return result;
}

function graphemeIndexAt(items: readonly Grapheme[], position: number): number {
  const containing = items.findIndex((item) => position >= item.start && position < item.end);
  if (containing >= 0) return containing;
  return items.findIndex((item) => item.start >= position);
}

function wordForward(value: string, position: number, count: number): number {
  const items = graphemes(value);
  let index = graphemeIndexAt(items, position);
  if (index < 0) return value.length;
  for (let step = 0; step < count; step += 1) {
    const current = items[index]?.kind;
    while (index < items.length && items[index].kind === current) index += 1;
    while (index < items.length && items[index].kind === "space") index += 1;
    if (index >= items.length) return value.length;
  }
  return items[index]?.start ?? value.length;
}

function wordBackward(value: string, position: number, count: number): number {
  const items = graphemes(value);
  let index = items.findIndex((item) => item.start >= position);
  index = (index < 0 ? items.length : index) - 1;
  for (let step = 0; step < count && index >= 0; step += 1) {
    while (index >= 0 && items[index].kind === "space") index -= 1;
    const current = items[index]?.kind;
    while (index > 0 && items[index - 1].kind === current) index -= 1;
    if (step < count - 1) index -= 1;
  }
  return index >= 0 ? items[index].start : 0;
}

function wordEnd(value: string, position: number, count: number): number {
  const items = graphemes(value);
  let index = graphemeIndexAt(items, position);
  if (index < 0) return Math.max(0, value.length - 1);
  for (let step = 0; step < count; step += 1) {
    while (index < items.length && items[index].kind === "space") index += 1;
    const current = items[index]?.kind;
    while (index + 1 < items.length && items[index + 1].kind === current) index += 1;
    if (step < count - 1) index += 1;
  }
  return items[Math.min(index, items.length - 1)]?.start ?? value.length;
}

function lineStarts(value: string): number[] {
  const starts = [0];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts: readonly number[], position: number): number {
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1] <= position) line += 1;
  return line;
}

function clampNormalColumn(value: string, start: number, column: number): number {
  const end = lineEnd(value, start);
  const target = Math.min(start + column, end);
  return target === end && end > start ? previousBoundary(value, end) : target;
}

export function caretForVerticalEntry(
  value: string,
  direction: -1 | 1,
  column: number,
): number {
  const start = direction > 0 ? 0 : lineStart(value, value.length);
  return clampNormalColumn(value, start, column);
}

interface TextMotion {
  kind: "text";
  position: number;
  inclusive: boolean;
  desiredColumn: number | null;
}

interface SurfaceMotion {
  kind: "surface";
  command: Extract<VimSurfaceCommand, { type: "focus" }>;
  desiredColumn: number;
}

type Motion = TextMotion | SurfaceMotion;

function verticalMotion(
  value: string,
  position: number,
  direction: -1 | 1,
  count: number,
  desiredColumn: number | null,
): Motion {
  const starts = lineStarts(value);
  const currentLine = lineIndexAt(starts, position);
  const column = desiredColumn ?? position - starts[currentLine];
  const targetLine = currentLine + direction * count;
  if (targetLine >= 0 && targetLine < starts.length) {
    return {
      kind: "text",
      position: clampNormalColumn(value, starts[targetLine], column),
      inclusive: false,
      desiredColumn: column,
    };
  }
  const remaining = targetLine < 0 ? targetLine : targetLine - (starts.length - 1);
  return {
    kind: "surface",
    command: {
      type: "focus",
      direction,
      count: Math.max(1, Math.abs(remaining)),
      column,
    },
    desiredColumn: column,
  };
}

function motionFor(
  snapshot: VimSnapshot,
  key: string,
  count: number,
  desiredColumn: number | null,
): Motion | null {
  const { value } = snapshot;
  const position = Math.min(snapshot.selectionStart, value.length);
  const mapped = key === "ArrowLeft"
    ? "h"
    : key === "ArrowDown" || key === "Enter"
      ? "j"
      : key === "ArrowUp"
        ? "k"
        : key === "ArrowRight"
          ? "l"
          : key === "Home"
            ? "0"
            : key === "End"
              ? "$"
              : key === "Backspace"
                ? "h"
                : key;
  if (mapped === "j" || mapped === "k") {
    return verticalMotion(value, position, mapped === "j" ? 1 : -1, count, desiredColumn);
  }
  if (mapped === "h" || mapped === "l") {
    let cursor = position;
    for (let step = 0; step < count; step += 1) {
      cursor = mapped === "h"
        ? Math.max(lineStart(value, cursor), previousBoundary(value, cursor))
        : Math.min(normalLineEnd(value, cursor), nextBoundary(value, cursor));
    }
    return { kind: "text", position: cursor, inclusive: false, desiredColumn: null };
  }
  if (mapped === "0") {
    return {
      kind: "text",
      position: lineStart(value, position),
      inclusive: false,
      desiredColumn: null,
    };
  }
  if (mapped === "^") {
    return {
      kind: "text",
      position: firstNonBlank(value, position),
      inclusive: false,
      desiredColumn: null,
    };
  }
  if (mapped === "$") {
    let cursor = position;
    for (let step = 1; step < count; step += 1) {
      const end = lineEnd(value, cursor);
      if (end >= value.length) break;
      cursor = end + 1;
    }
    return {
      kind: "text",
      position: normalLineEnd(value, cursor),
      inclusive: true,
      desiredColumn: null,
    };
  }
  if (mapped === "w") {
    return {
      kind: "text",
      position: wordForward(value, position, count),
      inclusive: false,
      desiredColumn: null,
    };
  }
  if (mapped === "b") {
    return {
      kind: "text",
      position: wordBackward(value, position, count),
      inclusive: false,
      desiredColumn: null,
    };
  }
  if (mapped === "e") {
    return {
      kind: "text",
      position: wordEnd(value, position, count),
      inclusive: true,
      desiredColumn: null,
    };
  }
  return null;
}

function normalCaretAfterEdit(value: string, position: number): number {
  if (value.length === 0) return 0;
  if (position < value.length) return position;
  return previousBoundary(value, value.length);
}

function editEffect(
  snapshot: VimSnapshot,
  from: number,
  to: number,
  insert: string,
  insertMode: boolean,
): VimEffect {
  const next = `${snapshot.value.slice(0, from)}${insert}${snapshot.value.slice(to)}`;
  const position = from + insert.length;
  const caret = insertMode ? position : normalCaretAfterEdit(next, position);
  return {
    kind: "edit",
    from,
    to,
    insert,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

function operatorRange(snapshot: VimSnapshot, motion: TextMotion): { from: number; to: number } {
  const start = snapshot.selectionStart;
  if (motion.position >= start) {
    return {
      from: start,
      to: motion.inclusive ? nextBoundary(snapshot.value, motion.position) : motion.position,
    };
  }
  return { from: motion.position, to: start };
}

function interpretOperator(
  state: VimState,
  snapshot: VimSnapshot,
  key: VimKey,
): VimInterpretation {
  if (/^[1-9]$/.test(key.key) || (key.key === "0" && state.count.length > 0)) {
    return result(appendCount(state, key.key));
  }
  const count = state.operatorCount * parsedCount(state.count);
  if (
    (state.operator === "delete" && key.key === "d")
    || (state.operator === "change" && key.key === "c")
  ) {
    if (!snapshot.editable) return result(normalState());
    if (state.operator === "delete") {
      return result(normalState(), [
        { kind: "surface", command: { type: "delete-unit", count } },
      ]);
    }
    return result(initialVimState("insert"), [
      editEffect(snapshot, 0, snapshot.value.length, "", true),
    ]);
  }
  if (state.operator === "indent" && key.key === ">") {
    return result(normalState(), snapshot.editable
      ? [{ kind: "surface", command: { type: "indent", count } }]
      : []);
  }
  if (state.operator === "outdent" && key.key === "<") {
    return result(normalState(), snapshot.editable
      ? [{ kind: "surface", command: { type: "outdent", count } }]
      : []);
  }
  if (state.operator !== "delete" && state.operator !== "change") {
    return result(normalState());
  }
  const motion = motionFor(snapshot, key.key, count, state.desiredColumn);
  if (!motion || motion.kind === "surface") return result(normalState());
  if (!snapshot.editable) return result(normalState());
  const range = operatorRange(snapshot, motion);
  if (range.from === range.to) return result(normalState());
  const changing = state.operator === "change";
  return result(changing ? initialVimState("insert") : normalState(), [
    editEffect(snapshot, range.from, range.to, "", changing),
  ]);
}

function enterInsert(
  snapshot: VimSnapshot,
  key: "i" | "a" | "I" | "A",
): VimInterpretation {
  if (!snapshot.editable) return result(normalState());
  const position = snapshot.selectionStart;
  const caret = key === "i"
    ? position
    : key === "a"
      ? Math.min(lineEnd(snapshot.value, position), nextBoundary(snapshot.value, position))
      : key === "I"
        ? firstNonBlank(snapshot.value, position)
        : lineEnd(snapshot.value, position);
  return result(initialVimState("insert"), [
    { kind: "selection", start: caret, end: caret },
  ]);
}

function deleteCharacters(snapshot: VimSnapshot, count: number): VimEffect | null {
  if (!snapshot.editable) return null;
  const from = snapshot.selectionStart;
  const end = lineEnd(snapshot.value, from);
  let to = from;
  for (let step = 0; step < count && to < end; step += 1) to = nextBoundary(snapshot.value, to);
  return to > from ? editEffect(snapshot, from, to, "", false) : null;
}

function interpretNormal(
  state: VimState,
  snapshot: VimSnapshot,
  key: VimKey,
): VimInterpretation {
  if (key.key === "Escape") return result(normalState());
  if (state.prefix === "g") {
    if (key.key === "g") {
      return result(normalState(), [
        { kind: "surface", command: { type: "focus-edge", edge: "first" } },
      ]);
    }
    return result(normalState());
  }
  if (/^[1-9]$/.test(key.key) || (key.key === "0" && state.count.length > 0)) {
    return result(appendCount(state, key.key));
  }
  const count = parsedCount(state.count);
  if (key.key === "g") return result({ ...state, prefix: "g" });
  if (key.key === "G") {
    return result(normalState(), [
      { kind: "surface", command: { type: "focus-edge", edge: "last" } },
    ]);
  }
  if (key.key === "d" || key.key === "c" || key.key === ">" || key.key === "<") {
    const operator: VimOperator = key.key === "d"
      ? "delete"
      : key.key === "c"
        ? "change"
        : key.key === ">"
          ? "indent"
          : "outdent";
    return result({
      ...initialVimState("operator-pending"),
      operator,
      operatorCount: count,
    });
  }
  if (key.key === "i" || key.key === "a" || key.key === "I" || key.key === "A") {
    return enterInsert(snapshot, key.key);
  }
  if (key.key === "o" || key.key === "O") {
    if (!snapshot.editable) return result(normalState());
    return result(initialVimState("insert"), [
      { kind: "surface", command: { type: "open", side: key.key === "o" ? "after" : "before" } },
    ]);
  }
  if (key.key === "u") {
    return result(normalState(), snapshot.editable
      ? [{ kind: "surface", command: { type: "history", redo: false } }]
      : []);
  }
  if (key.key === "Tab") {
    return result(normalState(), snapshot.editable
      ? [{
          kind: "surface",
          command: { type: key.shift ? "outdent" : "indent", count },
        }]
      : []);
  }
  if (key.key === "x" || key.key === "Delete") {
    const effect = deleteCharacters(snapshot, count);
    return result(normalState(), effect ? [effect] : []);
  }
  if (key.key === "D" || key.key === "C") {
    if (!snapshot.editable) return result(normalState());
    const from = snapshot.selectionStart;
    const to = lineEnd(snapshot.value, from);
    const changing = key.key === "C";
    return result(changing ? initialVimState("insert") : normalState(), to > from
      ? [editEffect(snapshot, from, to, "", changing)]
      : []);
  }
  const motion = motionFor(snapshot, key.key, count, state.desiredColumn);
  if (motion?.kind === "surface") {
    return result(normalState(motion.desiredColumn), [
      { kind: "surface", command: motion.command },
    ]);
  }
  if (motion) {
    return result(normalState(motion.desiredColumn), [
      { kind: "selection", start: motion.position, end: motion.position },
    ]);
  }
  // Once Normal mode owns an unmodified key, it must not fall through and type
  // that key into the native textarea or trigger the standard outline grammar.
  return result(normalState());
}

export function interpretVimKey(
  state: VimState,
  snapshot: VimSnapshot,
  key: VimKey,
): VimInterpretation {
  const escape = key.key === "Escape" || (key.ctrl && key.key === "[");
  if (state.mode === "insert") {
    if (!escape) return pass(state);
    const position = snapshot.selectionStart;
    const start = lineStart(snapshot.value, position);
    const caret = position > start ? previousBoundary(snapshot.value, position) : position;
    return result(normalState(), [
      { kind: "selection", start: caret, end: caret },
    ]);
  }
  if (escape) return result(normalState());
  if (key.ctrl && !key.meta && !key.alt && key.key.toLowerCase() === "r") {
    return result(normalState(), snapshot.editable
      ? [{ kind: "surface", command: { type: "history", redo: true } }]
      : []);
  }
  if (key.key === "ContextMenu" || (key.shift && key.key === "F10")) {
    return pass(state);
  }
  // Application and browser shortcuts keep their existing arbitration. Vim
  // owns bare keys (and Shift variants), not arbitrary modifier chords.
  if (key.ctrl || key.meta || key.alt) return pass(state);
  if (state.mode === "operator-pending") return interpretOperator(state, snapshot, key);
  return interpretNormal(state, snapshot, key);
}
