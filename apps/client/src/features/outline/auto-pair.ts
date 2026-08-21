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
  };
}
