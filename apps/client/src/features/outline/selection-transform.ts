export interface TextSelection {
  anchor: number;
  head: number;
}

/** Transforms UTF-16 textarea offsets through one contiguous text replacement.
 * A CRDT update may contain more than one operation, but comparing the old and
 * new projections as prefix/replaced-span/suffix gives a stable local caret and
 * preserves selection direction without importing editor state into the core. */
export function transformSelection(
  before: string,
  after: string,
  selection: TextSelection,
): TextSelection {
  if (before === after) return selection;
  let start = 0;
  const prefixLimit = Math.min(before.length, after.length);
  while (start < prefixLimit && before[start] === after[start]) start += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const map = (offset: number) => {
    if (offset <= start) return offset;
    if (offset >= oldEnd) return offset + (newEnd - oldEnd);
    return newEnd;
  };
  return { anchor: map(selection.anchor), head: map(selection.head) };
}
