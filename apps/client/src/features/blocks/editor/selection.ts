import { canonicalContentBoundary, type InlineContentProjection } from "./inline-content";
import { mapContentPosition, projectContent } from "./content-buffer";
import type { ContentProjectionChange } from "./content-session";
import { codePointIndex } from "./text-diff";

export interface TextSelection {
  anchor: number;
  head: number;
}

/** The UTF-16 offset of a content position: each reference atom spans its text. */
export function textOffset(projection: InlineContentProjection, index: number): number {
  let display = index;
  for (const reference of projection.pageReferences) {
    if (reference.index >= index) break;
    display += reference.end - reference.start - 1;
  }
  return Array.from(projection.markdown).slice(0, display).join("").length;
}

/** Convert native UTF-16 positions only at the input projection boundary. */
export function transformProjectedSelection(
  change: ContentProjectionChange,
  selection: TextSelection,
): TextSelection {
  const before = projectContent(change.before, change.beforeDirectory);
  const after = projectContent(change.after, change.afterDirectory);
  const afterPoints = Array.from(after.markdown);
  const map = (offset: number) => {
    const point = codePointIndex(before.markdown, offset);
    const reference = before.pageReferences.find(
      (entry) => entry.start < point && point < entry.end,
    );
    if (reference) {
      const index = mapContentPosition(reference.index, change.mapping);
      const next = after.pageReferences.find(
        (entry) => entry.index === index && entry.page_id === reference.page_id,
      );
      if (next) {
        const oldStart = Array.from(before.markdown).slice(0, reference.start).join("").length;
        const start = afterPoints.slice(0, next.start).join("").length;
        const length = afterPoints.slice(next.start, next.end).join("").length;
        return start + Math.min(offset - oldStart, length);
      }
    }
    const boundary = canonicalContentBoundary(before.markdown, before.pageReferences, offset);
    return textOffset(after, mapContentPosition(boundary.index, change.mapping, "before"));
  };
  return { anchor: map(selection.anchor), head: map(selection.head) };
}
