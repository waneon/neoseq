// Keys that mean something different inside code than in prose. Each returns
// the replacement a code editor makes, for the outline to apply through the
// same input path as typing.

export interface CodeEdit {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

/** The body's own indent unit: a tab, its narrowest space indent, or two spaces. */
export function indentUnit(body: string): string {
  let narrowest = Infinity;
  for (const line of body.split("\n")) {
    if (line.startsWith("\t")) return "\t";
    const spaces = /^ +(?=\S)/u.exec(line)?.[0].length;
    if (spaces) narrowest = Math.min(narrowest, spaces);
  }
  return narrowest === Infinity ? "  " : " ".repeat(narrowest);
}

function lineStart(value: string, offset: number): number {
  return value.lastIndexOf("\n", offset - 1) + 1;
}

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * A line break that keeps the current line's indentation, and goes one unit
 * deeper after an opening bracket or a line-ending colon. Between a bracket
 * pair the closer moves to its own line at the outer indentation.
 */
export function newline(value: string, start: number, end: number, unit: string): CodeEdit {
  const from = lineStart(value, start);
  const before = value.slice(from, start);
  const indent = /^[ \t]*/u.exec(before)![0];
  const last = before.trimEnd().at(-1) ?? "";
  const opens = CLOSER[last] !== undefined || last === ":";
  const inner = `\n${indent}${opens ? unit : ""}`;
  const insert =
    CLOSER[last] !== undefined && value[end] === CLOSER[last] ? `${inner}\n${indent}` : inner;
  const caret = start + inner.length;
  return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret };
}

/** A closer typed on a blank line returns it to the opener's indentation. */
export function closeLine(
  value: string,
  start: number,
  closer: string,
  unit: string,
): CodeEdit | null {
  const from = lineStart(value, start);
  const indent = value.slice(from, start);
  if (!/^[ \t]+$/u.test(indent) || value[start] === closer) return null;
  const outdented = indent.startsWith("\t") ? indent.slice(1) : indent.slice(unit.length);
  const insert = `${outdented}${closer}`;
  const caret = from + insert.length;
  return { from, to: start, insert, selectionStart: caret, selectionEnd: caret };
}

/** Backspace in space indentation removes back to the previous indent stop. */
export function outdentBackspace(value: string, start: number, unit: string): CodeEdit | null {
  if (unit === "\t") return null;
  const from = lineStart(value, start);
  const indent = value.slice(from, start);
  if (indent.length === 0 || !/^ +$/u.test(indent)) return null;
  const remove = ((indent.length - 1) % unit.length) + 1;
  return {
    from: start - remove,
    to: start,
    insert: "",
    selectionStart: start - remove,
    selectionEnd: start - remove,
  };
}

/**
 * Tab inserts one unit at a caret; with a selection, or with Shift, it indents
 * or outdents every line the selection touches and keeps those lines selected.
 */
export function indent(
  value: string,
  start: number,
  end: number,
  unit: string,
  outdent: boolean,
): CodeEdit {
  if (!outdent && start === end) {
    const caret = start + unit.length;
    return { from: start, to: end, insert: unit, selectionStart: caret, selectionEnd: caret };
  }
  const from = lineStart(value, start);
  // A selection ending at a line's start does not reach into that line.
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", last);
  const to = nextBreak === -1 ? value.length : nextBreak;
  let shiftStart = 0;
  let shiftEnd = 0;
  let offset = from;
  const lines = value
    .slice(from, to)
    .split("\n")
    .map((line, index) => {
      let changed: string;
      if (outdent) {
        const removable = line.startsWith("\t") ? 1 : /^ */u.exec(line)![0].length;
        changed = line.slice(Math.min(removable, unit === "\t" ? 1 : unit.length));
      } else {
        changed = line.length === 0 && start !== end ? line : unit + line;
      }
      const delta = changed.length - line.length;
      if (index === 0) shiftStart = Math.max(delta, from - start);
      if (offset <= end) shiftEnd += delta;
      offset += line.length + 1;
      return changed;
    });
  return {
    from,
    to,
    insert: lines.join("\n"),
    selectionStart: Math.max(from, start + shiftStart),
    selectionEnd: Math.max(from, end + shiftEnd),
  };
}
