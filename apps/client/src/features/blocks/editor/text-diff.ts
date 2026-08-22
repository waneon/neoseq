// Minimal single-range diff between two strings, expressed in Unicode code
// points to match `SpliceMarkdown` semantics in the core.

export interface Splice {
  index: number;
  delete: number;
  insert: string;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

/** UTF-16 offset → code point index (never splits surrogate pairs). */
export function codePointIndex(value: string, utf16Offset: number): number {
  let index = 0;
  let offset = 0;
  for (const point of value) {
    if (offset >= utf16Offset) break;
    offset += point.length;
    index += 1;
  }
  return index;
}

export function diffSplice(before: string, after: string): Splice | null {
  if (before === after) return null;
  const left = codePoints(before);
  const right = codePoints(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    index: prefix,
    delete: left.length - prefix - suffix,
    insert: right.slice(prefix, right.length - suffix).join(""),
  };
}
