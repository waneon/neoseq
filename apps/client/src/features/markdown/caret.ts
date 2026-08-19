/**
 * Maps a point in the reading projection back to an offset in the block's
 * Markdown source, so pressing rendered text opens the editor with the caret
 * where the reader pressed rather than at the end of the block.
 *
 * The projection carries no source positions. It does not need them: the
 * rendered text and its source are the same characters in the same order, with
 * syntax interleaved. Walking both once and only ever advancing the source
 * pointer when the two disagree lands the caret inside the pressed word for
 * every construct in the profile, and cannot run backwards.
 */

interface CaretPoint {
  node: Node;
  offset: number;
}

/** `caretRangeFromPoint` predates the standard and is still WebKit's only one. */
interface LegacyCaretDocument {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function caretPointFromCoordinates(x: number, y: number): CaretPoint | null {
  const doc: Document & LegacyCaretDocument = document;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  // WebKit ships only the Range-shaped predecessor.
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\n" || character === "\t" || character === "\r";
}

/**
 * Walks `source` and `rendered` together until `rendered` has been consumed up
 * to `index`, and returns how far into `source` that reached. Whitespace is
 * matched loosely because a source newline renders as a line break that
 * contributes no text, and a collapsed run renders as one space.
 */
export function alignSourceOffset(source: string, rendered: string, index: number): number {
  let read = 0;
  let shown = 0;
  while (read < source.length && shown < index) {
    const sourceCharacter = source[read];
    const shownCharacter = rendered[shown];
    if (sourceCharacter === shownCharacter) {
      read += 1;
      shown += 1;
    } else if (isWhitespace(sourceCharacter) && isWhitespace(shownCharacter)) {
      read += 1;
      shown += 1;
    } else if (isWhitespace(shownCharacter)) {
      shown += 1;
    } else {
      // Syntax, or a character reference the source spelled out: source only.
      read += 1;
    }
  }
  // Stopping the instant the rendered text runs out would leave the caret in
  // front of whatever syntax produces the next character — a list marker, a
  // closing delimiter — instead of in the text the reader pressed.
  const next = rendered[index];
  if (next !== undefined) {
    while (
      read < source.length
      && source[read] !== next
      && !(isWhitespace(source[read]) && isWhitespace(next))
    ) {
      read += 1;
    }
  }
  return read;
}

/**
 * Returns the source offset under the given viewport point, or `null` when the
 * platform cannot resolve one — in which case the caller keeps its own default.
 */
export function sourceOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  source: string,
): number | null {
  const point = caretPointFromCoordinates(clientX, clientY);
  if (!point || !root.contains(point.node)) return null;
  const range = document.createRange();
  try {
    range.setStart(root, 0);
    range.setEnd(point.node, point.offset);
  } catch {
    return null;
  }
  return alignSourceOffset(source, root.textContent ?? "", range.toString().length);
}
