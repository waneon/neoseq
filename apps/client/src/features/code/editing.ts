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

/** A line break that keeps the current line's indentation. */
export function newline(value: string, start: number, end: number): CodeEdit {
  const from = lineStart(value, start);
  const indent = /^[ \t]*/u.exec(value.slice(from, start))![0];
  const insert = `\n${indent}`;
  const caret = start + insert.length;
  return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret };
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
