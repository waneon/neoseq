// Plans the small, local text transformations behind paired delimiters.
// Offsets stay in UTF-16 because this boundary consumes textarea selections;
// the existing draft diff converts the eventual write to core code points.

export type PairSelectionDirection = "forward" | "backward" | "none";

export interface AutoPairInput {
  value: string;
  start: number;
  end: number;
  direction: PairSelectionDirection;
  inputType: string;
  data: string | null;
  isComposing: boolean;
}

export interface TextEditPlan {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: PairSelectionDirection;
  autoCloser?: AutoCloserMarker;
}

/**
 * Ephemeral provenance for a closer inserted by auto-pairing. The offset is a
 * UTF-16 textarea offset pointing at the closer in the current value.
 */
export interface AutoCloserMarker {
  opener: string;
  closer: string;
  offset: number;
}

const PAIRS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
]);
const CLOSERS: ReadonlySet<string> = new Set(PAIRS.values());
const SYMMETRIC: ReadonlySet<string> = new Set(['"', "'", "`"]);
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function previousPoint(value: string, offset: number): string {
  return Array.from(value.slice(0, offset)).at(-1) ?? "";
}

function nextPoint(value: string, offset: number): string {
  return Array.from(value.slice(offset))[0] ?? "";
}

function isEscaped(value: string, offset: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function canOpenSymmetric(value: string, start: number, end: number): boolean {
  const previous = previousPoint(value, start);
  const next = nextPoint(value, end);
  return !WORD_CHARACTER.test(previous) && !WORD_CHARACTER.test(next);
}

interface ContiguousEdit {
  start: number;
  oldEnd: number;
  newEnd: number;
}

function contiguousEdit(
  before: string,
  after: string,
  preferredStart?: number,
  preferredEnd: number = preferredStart ?? 0,
): ContiguousEdit {
  if (
    preferredStart !== undefined &&
    preferredStart >= 0 &&
    preferredEnd >= preferredStart &&
    preferredEnd <= before.length
  ) {
    const insertedLength = after.length - before.length + preferredEnd - preferredStart;
    const newEnd = preferredStart + insertedLength;
    if (
      insertedLength >= 0 &&
      after.slice(0, preferredStart) === before.slice(0, preferredStart) &&
      after.slice(newEnd) === before.slice(preferredEnd)
    ) {
      return { start: preferredStart, oldEnd: preferredEnd, newEnd };
    }
  }

  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }

  let oldEnd = before.length;
  let newEnd = after.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === after[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return { start, oldEnd, newEnd };
}

/**
 * Carries auto-closer provenance across an observed text replacement. Markers
 * whose closer was replaced disappear; all others follow their text.
 */
export function transformAutoClosers(
  before: string,
  after: string,
  markers: readonly AutoCloserMarker[],
  preferredStart?: number,
  preferredEnd?: number,
): AutoCloserMarker[] {
  if (before === after) {
    return markers.filter(
      (marker) => after.slice(marker.offset, marker.offset + marker.closer.length) === marker.closer,
    );
  }

  const { start, oldEnd, newEnd } = contiguousEdit(
    before,
    after,
    preferredStart,
    preferredEnd,
  );
  const delta = newEnd - oldEnd;
  const transformed: AutoCloserMarker[] = [];

  for (const marker of markers) {
    let offset = marker.offset;
    if (offset >= oldEnd) {
      offset += delta;
    } else if (offset >= start) {
      continue;
    }

    if (after.slice(offset, offset + marker.closer.length) === marker.closer) {
      transformed.push({ ...marker, offset });
    }
  }

  return transformed;
}

/**
 * Repairs a closer inserted by a non-cancelable IME input immediately before
 * an auto-generated closer. Unlike ordinary closer overtype, this runs after
 * the browser mutation and therefore relies on provenance rather than text
 * equality alone.
 */
export function planAutoPairInputRepair(
  before: string,
  after: string,
  markers: readonly AutoCloserMarker[],
  preferredStart?: number,
  preferredEnd?: number,
): TextEditPlan | null {
  if (before === after || markers.length === 0) return null;

  const edit = contiguousEdit(before, after, preferredStart, preferredEnd);
  const inserted = after.slice(edit.start, edit.newEnd);
  if (inserted.length === 0) return null;

  const transformed = transformAutoClosers(
    before,
    after,
    markers,
    preferredStart,
    preferredEnd,
  );
  for (const marker of transformed) {
    const insertedCloserStart = edit.newEnd - marker.closer.length;
    if (
      marker.offset !== edit.newEnd ||
      insertedCloserStart < edit.start ||
      !inserted.endsWith(marker.closer) ||
      after.slice(insertedCloserStart, edit.newEnd) !== marker.closer ||
      after.slice(marker.offset, marker.offset + marker.closer.length) !== marker.closer
    ) {
      continue;
    }

    return {
      from: insertedCloserStart,
      to: edit.newEnd,
      insert: "",
      selectionStart: marker.offset,
      selectionEnd: marker.offset,
      selectionDirection: "none",
      autoCloser: {
        ...marker,
        offset: marker.offset - marker.closer.length,
      },
    };
  }

  return null;
}

/**
 * Returns the complete replacement and resulting selection for one beforeinput
 * intent. `null` means the browser should perform its ordinary edit.
 */
export function planAutoPair(input: AutoPairInput): TextEditPlan | null {
  if (input.isComposing) return null;

  const { value, start, end, direction } = input;
  if (start < 0 || end < start || end > value.length) return null;

  if (input.inputType === "deleteContentBackward") {
    if (start !== end || start === 0 || end === value.length) return null;
    const opener = value.slice(start - 1, start);
    const closer = value.slice(end, end + 1);
    if (PAIRS.get(opener) !== closer) return null;
    return {
      from: start - 1,
      to: end + 1,
      insert: "",
      selectionStart: start - 1,
      selectionEnd: start - 1,
      selectionDirection: "none",
    };
  }

  if (input.inputType !== "insertText" || input.data === null) return null;
  const typed = input.data;
  if (typed.length !== 1) return null;

  // A closer already under a collapsed caret is accepted by moving across it,
  // not by producing a duplicate. Symmetric pairs use the same rule.
  if (start === end && CLOSERS.has(typed) && value.slice(start, start + 1) === typed) {
    return {
      from: start,
      to: start,
      insert: "",
      selectionStart: start + 1,
      selectionEnd: start + 1,
      selectionDirection: "none",
    };
  }

  const closer = PAIRS.get(typed);
  if (closer === undefined) return null;

  const selected = value.slice(start, end);
  if (start !== end) {
    return {
      from: start,
      to: end,
      insert: `${typed}${selected}${closer}`,
      selectionStart: start + typed.length,
      selectionEnd: end + typed.length,
      selectionDirection: direction,
      autoCloser: {
        opener: typed,
        closer,
        offset: start + typed.length + selected.length,
      },
    };
  }

  // Escaped Markdown delimiters are literal. Quotes and backticks also need a
  // boundary on both sides, otherwise apostrophes and manually closed spans
  // would grow a surprising second delimiter.
  if (isEscaped(value, start)) return null;
  if (SYMMETRIC.has(typed) && !canOpenSymmetric(value, start, end)) return null;

  return {
    from: start,
    to: end,
    insert: `${typed}${closer}`,
    selectionStart: start + typed.length,
    selectionEnd: start + typed.length,
    selectionDirection: "none",
    autoCloser: { opener: typed, closer, offset: start + typed.length },
  };
}
