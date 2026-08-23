// A small, surface-neutral Vim grammar for Neoseq block text.
//
// The engine knows strings, insertion offsets, modes, counts and operators. It
// does not know React, textarea DOM, outline trees or query rows. Structural
// commands leave as intents so each editing surface can preserve its own rules.

export type VimMode = "normal" | "insert" | "operator-pending" | "visual-line";
export type VimOperator = "delete" | "change" | "indent" | "outdent";
export type VimTextObjectModifier = "inner" | "around";

export interface VimState {
  mode: VimMode;
  count: string;
  operator: VimOperator | null;
  operatorCount: number;
  textObject: VimTextObjectModifier | null;
  prefix: "g" | null;
  /** Logical column retained across vertical motion. */
  desiredColumn: number | null;
}

export interface VimSnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  editable: boolean;
  /** Whether this host can turn a linewise selection into structural units. */
  supportsVisualLine?: boolean;
  /** Whether word motions may continue through adjacent text units. */
  supportsCrossBlockWords?: boolean;
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
  | VimWordMotionCommand
  | { type: "open"; side: "before" | "after" }
  | { type: "delete-unit"; count: number }
  | { type: "indent"; count: number }
  | { type: "outdent"; count: number }
  | { type: "history"; redo: boolean }
  | VimVisualLineCommand;

export type VimWordMotion = "w" | "b" | "e";

export interface VimWordMotionCommand {
  type: "word-motion";
  motion: VimWordMotion;
  count: number;
  caret: number;
  operator: "delete" | "change" | null;
}

export type VimVisualLineCommand =
  | {
      type: "visual-line";
      action: "begin";
      count: number;
      caret: number;
      column: number;
    }
  | { type: "visual-line"; action: "move"; direction: -1 | 1; count: number }
  | { type: "visual-line"; action: "edge"; edge: "first" | "last" }
  | { type: "visual-line"; action: "cancel" }
  | {
      type: "visual-line";
      action: "delete" | "indent" | "outdent";
    };

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
    textObject: null,
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

interface TextRun {
  start: number;
  end: number;
  kind: WordClass;
}

function textRuns(value: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of graphemes(value)) {
    const prior = runs[runs.length - 1];
    if (prior?.kind === item.kind) {
      prior.end = item.end;
    } else {
      runs.push({ ...item });
    }
  }
  return runs;
}

function runIndexAt(items: readonly TextRun[], position: number): number {
  const containing = items.findIndex((item) => position >= item.start && position < item.end);
  if (containing >= 0) return containing;
  return position >= (items[items.length - 1]?.end ?? 0) ? items.length - 1 : 0;
}

function innerWordRange(
  items: readonly TextRun[],
  index: number,
  count: number,
): { from: number; to: number } | null {
  const end = index + count - 1;
  if (end >= items.length) return null;
  return { from: items[index].start, to: items[end].end };
}

function aroundWordRange(
  items: readonly TextRun[],
  index: number,
  count: number,
): { from: number; to: number } | null {
  if (items[index].kind === "space") {
    let end = index;
    let words = 0;
    while (end + 1 < items.length && words < count) {
      end += 1;
      if (items[end].kind !== "space") words += 1;
    }
    return words === count ? { from: items[index].start, to: items[end].end } : null;
  }

  let end = index;
  let words = 1;
  while (end + 1 < items.length && words < count) {
    end += 1;
    if (items[end].kind !== "space") words += 1;
  }
  if (words < count) return null;
  if (items[end + 1]?.kind === "space") {
    end += 1;
    return { from: items[index].start, to: items[end].end };
  }
  const start = items[index - 1]?.kind === "space" ? index - 1 : index;
  return { from: items[start].start, to: items[end].end };
}

function wordTextObjectRange(
  value: string,
  position: number,
  modifier: VimTextObjectModifier,
  count: number,
): { from: number; to: number } | null {
  const items = textRuns(value);
  if (items.length === 0) return null;
  const index = runIndexAt(items, Math.max(0, Math.min(position, value.length)));
  return modifier === "inner"
    ? innerWordRange(items, index, count)
    : aroundWordRange(items, index, count);
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
    let crossedSpace = false;
    while (index < items.length && items[index].kind === "space") {
      crossedSpace = true;
      index += 1;
    }
    if (
      !crossedSpace
      && index < items.length
      && items[index].kind !== "space"
      && items[index + 1]?.kind !== items[index].kind
    ) {
      index += 1;
      while (index < items.length && items[index].kind === "space") index += 1;
    }
    if (index >= items.length) return items[items.length - 1]?.start ?? 0;
    const current = items[index]?.kind;
    while (index + 1 < items.length && items[index + 1].kind === current) index += 1;
    if (step < count - 1) index += 1;
  }
  return items[Math.min(index, items.length - 1)]?.start ?? value.length;
}

export interface VimWordPosition {
  unit: number;
  offset: number;
}

export interface VimWordEdit {
  unit: number;
  from: number;
  to: number;
}

interface JoinedTextUnits {
  value: string;
  starts: number[];
}

function joinTextUnits(values: readonly string[]): JoinedTextUnits {
  const starts: number[] = [];
  let offset = 0;
  for (const value of values) {
    starts.push(offset);
    offset += value.length + 1;
  }
  return { value: values.join("\n"), starts };
}

function positionInUnits(
  values: readonly string[],
  starts: readonly number[],
  position: number,
): VimWordPosition {
  if (values.length === 0) return { unit: 0, offset: 0 };
  const last = values.length - 1;
  const clamped = Math.max(0, Math.min(position, starts[last] + values[last].length));
  let unit = starts.length - 1;
  while (unit > 0 && starts[unit] > clamped) unit -= 1;
  return {
    unit,
    offset: Math.min(values[unit].length, clamped - starts[unit]),
  };
}

function globalWordMotion(
  value: string,
  position: number,
  motion: VimWordMotion,
  count: number,
): number {
  if (motion === "w") return wordForward(value, position, count);
  if (motion === "b") return wordBackward(value, position, count);
  return wordEnd(value, position, count);
}

/** A pure word motion over text units separated by structural newlines. */
export function wordMotionAcrossUnits(
  values: readonly string[],
  start: VimWordPosition,
  motion: VimWordMotion,
  count: number,
): VimWordPosition {
  if (values.length === 0) return start;
  const joined = joinTextUnits(values);
  const unit = Math.max(0, Math.min(start.unit, values.length - 1));
  const local = Math.max(0, Math.min(start.offset, values[unit].length));
  const target = globalWordMotion(
    joined.value,
    joined.starts[unit] + local,
    motion,
    Math.max(1, count),
  );
  return positionInUnits(values, joined.starts, target);
}

/** Text spans removed by an operator; structural separators are never edits. */
export function wordEditsAcrossUnits(
  values: readonly string[],
  start: VimWordPosition,
  motion: VimWordMotion,
  count: number,
): { caret: VimWordPosition; edits: VimWordEdit[] } {
  if (values.length === 0) return { caret: start, edits: [] };
  const joined = joinTextUnits(values);
  const unit = Math.max(0, Math.min(start.unit, values.length - 1));
  const local = Math.max(0, Math.min(start.offset, values[unit].length));
  const origin = joined.starts[unit] + local;
  const target = globalWordMotion(joined.value, origin, motion, Math.max(1, count));
  const from = Math.min(origin, target);
  const to = target >= origin && motion === "e"
    ? nextBoundary(joined.value, target)
    : Math.max(origin, target);
  const edits: VimWordEdit[] = [];
  values.forEach((value, index) => {
    const unitStart = joined.starts[index];
    const editFrom = Math.max(0, from - unitStart);
    const editTo = Math.min(value.length, to - unitStart);
    if (editTo > editFrom) edits.push({ unit: index, from: editFrom, to: editTo });
  });
  return { caret: positionInUnits(values, joined.starts, from), edits };
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

export function normalCaretAfterEdit(value: string, position: number): number {
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

function isWordMotion(key: string): key is VimWordMotion {
  return key === "w" || key === "b" || key === "e";
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
  const editsText = state.operator === "delete" || state.operator === "change";
  if (editsText && state.textObject === null && (key.key === "i" || key.key === "a")) {
    return result({
      ...state,
      textObject: key.key === "i" ? "inner" : "around",
    });
  }
  if (state.textObject !== null) {
    if (!editsText || key.key !== "w" || !snapshot.editable) return result(normalState());
    const range = wordTextObjectRange(
      snapshot.value,
      snapshot.selectionStart,
      state.textObject,
      count,
    );
    if (!range || range.from === range.to) return result(normalState());
    const changing = state.operator === "change";
    return result(changing ? initialVimState("insert") : normalState(), [
      editEffect(snapshot, range.from, range.to, "", changing),
    ]);
  }
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
  if (snapshot.supportsCrossBlockWords && isWordMotion(key.key)) {
    if (!snapshot.editable) return result(normalState());
    const changing = state.operator === "change";
    return result(changing ? initialVimState("insert") : normalState(), [
      {
        kind: "surface",
        command: {
          type: "word-motion",
          motion: key.key,
          count,
          caret: snapshot.selectionStart,
          operator: state.operator,
        },
      },
    ]);
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

function interpretVisualLine(state: VimState, key: VimKey): VimInterpretation {
  const finish = (action: "cancel" | "delete" | "indent" | "outdent") =>
    result(normalState(), [{ kind: "surface", command: { type: "visual-line", action } }]);

  if (key.key === "Escape" || key.key === "V" || (key.ctrl && key.key === "[")) {
    return finish("cancel");
  }
  if (key.key === "ContextMenu" || (key.shift && key.key === "F10")) return pass(state);
  if (key.ctrl || key.meta || key.alt) return pass(state);
  if (/^[1-9]$/.test(key.key) || (key.key === "0" && state.count.length > 0)) {
    return result(appendCount(state, key.key));
  }
  if (state.prefix === "g") {
    if (key.key === "g") {
      return result(initialVimState("visual-line"), [
        {
          kind: "surface",
          command: { type: "visual-line", action: "edge", edge: "first" },
        },
      ]);
    }
    return result(initialVimState("visual-line"));
  }

  const count = parsedCount(state.count);
  if (key.key === "g") return result({ ...state, prefix: "g" });
  if (key.key === "G") {
    return result(initialVimState("visual-line"), [
      {
        kind: "surface",
        command: { type: "visual-line", action: "edge", edge: "last" },
      },
    ]);
  }
  if (key.key === "j" || key.key === "ArrowDown" || key.key === "Enter") {
    return result(initialVimState("visual-line"), [
      {
        kind: "surface",
        command: { type: "visual-line", action: "move", direction: 1, count },
      },
    ]);
  }
  if (key.key === "k" || key.key === "ArrowUp") {
    return result(initialVimState("visual-line"), [
      {
        kind: "surface",
        command: { type: "visual-line", action: "move", direction: -1, count },
      },
    ]);
  }
  if (key.key === "d" || key.key === "x" || key.key === "Delete" || key.key === "Backspace") {
    return finish("delete");
  }
  if (key.key === ">" || (key.key === "Tab" && !key.shift)) return finish("indent");
  if (key.key === "<" || (key.key === "Tab" && key.shift)) return finish("outdent");

  // Unsupported linewise commands remain inside Visual Line without falling
  // through to the tree's non-modal selection grammar.
  return result(initialVimState("visual-line"));
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
  if (key.key === "V") {
    if (!snapshot.supportsVisualLine) return result(normalState());
    const currentLine = lineStart(snapshot.value, snapshot.selectionStart);
    return result(initialVimState("visual-line"), [
      {
        kind: "surface",
        command: {
          type: "visual-line",
          action: "begin",
          count,
          caret: snapshot.selectionStart,
          column: snapshot.selectionStart - currentLine,
        },
      },
    ]);
  }
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
  if (snapshot.supportsCrossBlockWords && isWordMotion(key.key)) {
    return result(normalState(), [
      {
        kind: "surface",
        command: {
          type: "word-motion",
          motion: key.key,
          count,
          caret: snapshot.selectionStart,
          operator: null,
        },
      },
    ]);
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
  if (state.mode === "visual-line") return interpretVisualLine(state, key);
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
