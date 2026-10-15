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

/**
 * The smallest splice from `before` to `after`. Inside a repeated run several
 * are equally small; `caret`, a UTF-16 offset into `after`, picks the one that
 * ends there, where the input happened.
 */
export function diffSplice(before: string, after: string, caret?: number): Splice | null {
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
  const remove = left.length - prefix - suffix;
  const insert = right.length - prefix - suffix;
  if (caret !== undefined && (remove === 0 || insert === 0)) {
    const end = codePointIndex(after, caret);
    const changed = insert === 0 ? left : right;
    const length = remove + insert;
    while (
      prefix > 0 &&
      prefix + insert > end &&
      changed[prefix - 1] === changed[prefix + length - 1]
    )
      prefix -= 1;
  }
  return {
    index: prefix,
    delete: remove,
    insert: right.slice(prefix, prefix + insert).join(""),
  };
}
