// A code block is a block whose whole source is one fenced code block.
//
// The fence stays in the canonical Markdown, so synchronization, history,
// search, copy, and export see ordinary text, and the info string is the only
// place a language is written. Only this exact shape is edited as code: a block
// that mixes prose and a fence, or whose fence a concurrent edit broke, is
// ordinary Markdown again and loses nothing.

export interface CodeFence {
  /** The opening and closing run: three or more backticks or tildes. */
  marker: string;
  /** The opening line's info string, trimmed; its first word names the language. */
  info: string;
  body: string;
  /** Offsets of `body` in the source, between the two fence lines. */
  bodyStart: number;
  bodyEnd: number;
}

const OPENING = /^(`{3,}|~{3,})([^\n]*)$/u;

/** Lines that would close a fence of `char` (CommonMark allows three spaces). */
function closingRun(line: string, char: string): number {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  return match && match[1][0] === char ? match[1].length : 0;
}

function parse(source: string) {
  const lines = source.split("\n");
  if (lines.length < 3) return null;
  const opening = OPENING.exec(lines[0]);
  if (!opening) return null;
  const marker = opening[1];
  const info = opening[2];
  if (marker[0] === "`" && info.includes("`")) return null;
  const last = lines[lines.length - 1];
  const close = /^(`{3,}|~{3,})[ \t]*$/u.exec(last);
  if (!close || close[1][0] !== marker[0]) return null;
  const bodyStart = lines[0].length + 1;
  const bodyEnd = source.length - last.length - 1;
  return { marker, info, closeLength: close[1].length, lines, bodyStart, bodyEnd };
}

/** The longest run inside `lines` that could close a fence of `char`. */
function longestClosingRun(lines: readonly string[], char: string): number {
  return lines.reduce((longest, line) => Math.max(longest, closingRun(line, char)), 0);
}

export function codeFence(source: string): CodeFence | null {
  const parsed = parse(source);
  if (!parsed) return null;
  const { marker, info, closeLength, lines, bodyStart, bodyEnd } = parsed;
  if (closeLength < marker.length) return null;
  if (longestClosingRun(lines.slice(1, -1), marker[0]) >= marker.length) return null;
  return { marker, info: info.trim(), body: source.slice(bodyStart, bodyEnd), bodyStart, bodyEnd };
}

/**
 * Lengthens both fence lines when the body gained a line that would close them,
 * so typing a fence inside code keeps the block code. Returns `null` when the
 * source needs no change or is not fenced code at all.
 */
export function lengthenFence(source: string): { source: string; added: number } | null {
  const parsed = parse(source);
  if (!parsed) return null;
  const { marker, info, lines } = parsed;
  const needed = longestClosingRun(lines.slice(1, -1), marker[0]) + 1;
  if (needed <= marker.length) return null;
  const longer = marker[0].repeat(needed);
  const body = lines.slice(1, -1).join("\n");
  return { source: `${longer}${info}\n${body}\n${longer}`, added: needed - marker.length };
}

/** The canonical source for `body` as a code block naming `info`. */
export function fencedSource(body: string, info = ""): string {
  const needed = Math.max(3, longestClosingRun(body.split("\n"), "`") + 1);
  const marker = "`".repeat(needed);
  return `${marker}${info}\n${body}\n${marker}`;
}

/** `source` with its opening line naming `info` instead. */
export function withInfo(source: string, fence: CodeFence, info: string): string {
  return `${fence.marker}${info}\n${source.slice(fence.bodyStart)}`;
}
