import type { BlockContentSplice, InlineContent } from "../../../core-port/commands";
import type { PageReferenceSpan } from "../../../core-port/snapshot";
import { codePointIndex, diffSplice } from "./text-diff";

export interface InlineEditPlan {
  splice: BlockContentSplice;
  references: PageReferenceSpan[];
}

export interface InlineContentProjection {
  markdown: string;
  pageReferences: readonly PageReferenceSpan[];
}

export interface InlineContentBoundary {
  index: number;
  utf16Offset: number;
}

function ordered(references: readonly PageReferenceSpan[]): PageReferenceSpan[] {
  return [...references].sort((left, right) => left.start - right.start);
}

function logicalBoundary(position: number, references: readonly PageReferenceSpan[]): number {
  let collapsed = 0;
  for (const reference of references) {
    if (reference.end > position) break;
    collapsed += reference.end - reference.start - 1;
  }
  return position - collapsed;
}

/** UTF-16 textarea boundary to the nearest canonical atom boundary. */
export function canonicalContentBoundary(
  value: string,
  referencesInput: readonly PageReferenceSpan[],
  utf16Offset: number,
): InlineContentBoundary {
  const position = codePointIndex(value, utf16Offset);
  const references = ordered(referencesInput);
  for (const reference of references) {
    if (position <= reference.start) break;
    if (position < reference.end) {
      const after = position - reference.start >= (reference.end - reference.start) / 2;
      const displayPosition = after ? reference.end : reference.start;
      return {
        index: reference.index + Number(after),
        utf16Offset: Array.from(value).slice(0, displayPosition).join("").length,
      };
    }
  }
  return { index: logicalBoundary(position, references), utf16Offset };
}

/** Splits both the display projection and its canonical reference coordinates. */
export function splitInlineContentProjection(
  value: string,
  referencesInput: readonly PageReferenceSpan[],
  boundary: InlineContentBoundary,
): { head: InlineContentProjection; tail: InlineContentProjection } {
  const displayIndex = codePointIndex(value, boundary.utf16Offset);
  const references = ordered(referencesInput);
  return {
    head: {
      markdown: value.slice(0, boundary.utf16Offset),
      pageReferences: references.filter((reference) => reference.end <= displayIndex),
    },
    tail: {
      markdown: value.slice(boundary.utf16Offset),
      pageReferences: references
        .filter((reference) => reference.start >= displayIndex)
        .map((reference) => ({
          ...reference,
          start: reference.start - displayIndex,
          end: reference.end - displayIndex,
          index: reference.index - boundary.index,
        })),
    },
  };
}

/** Concatenates two display projections while preserving canonical atom positions. */
export function joinInlineContentProjections(
  head: InlineContentProjection,
  tail: InlineContentProjection,
): InlineContentProjection {
  const displayOffset = Array.from(head.markdown).length;
  const logicalOffset = logicalBoundary(displayOffset, ordered(head.pageReferences));
  return {
    markdown: `${head.markdown}${tail.markdown}`,
    pageReferences: [
      ...head.pageReferences,
      ...tail.pageReferences.map((reference) => ({
        ...reference,
        start: reference.start + displayOffset,
        end: reference.end + displayOffset,
        index: reference.index + logicalOffset,
      })),
    ],
  };
}

function touchedBy(reference: PageReferenceSpan, start: number, end: number): boolean {
  return start === end
    ? reference.start < start && start < reference.end
    : reference.start < end && start < reference.end;
}

function transformReferences(
  references: readonly PageReferenceSpan[],
  start: number,
  end: number,
  displayLength: number,
  logicalDelta: number,
): PageReferenceSpan[] {
  const displayDelta = displayLength - (end - start);
  return references.flatMap((reference) => {
    if (reference.end <= start) return [reference];
    if (reference.start >= end) {
      return [
        {
          ...reference,
          start: reference.start + displayDelta,
          end: reference.end + displayDelta,
          index: reference.index + logicalDelta,
        },
      ];
    }
    return [];
  });
}

function expandedRange(
  references: readonly PageReferenceSpan[],
  start: number,
  end: number,
): { start: number; end: number } {
  let expandedStart = start;
  let expandedEnd = end;
  for (const reference of references) {
    if (!touchedBy(reference, start, end)) continue;
    expandedStart = Math.min(expandedStart, reference.start);
    expandedEnd = Math.max(expandedEnd, reference.end);
  }
  return { start: expandedStart, end: expandedEnd };
}

/**
 * Maps one textarea edit back into canonical inline-content coordinates.
 * Editing through any part of a reference deliberately demotes that complete
 * reference to ordinary Markdown; edits at either boundary preserve it.
 */
export function planInlineEdit(
  blockId: string,
  before: string,
  referencesInput: readonly PageReferenceSpan[],
  after: string,
): InlineEditPlan | null {
  const diff = diffSplice(before, after);
  if (!diff) return null;
  const references = ordered(referencesInput);
  const beforePoints = Array.from(before);
  const range = expandedRange(references, diff.index, diff.index + diff.delete);
  const replacement = [
    ...beforePoints.slice(range.start, diff.index),
    ...Array.from(diff.insert),
    ...beforePoints.slice(diff.index + diff.delete, range.end),
  ].join("");
  const index = logicalBoundary(range.start, references);
  const deleteCount = logicalBoundary(range.end, references) - index;
  const insertLength = Array.from(replacement).length;
  const nextReferences = transformReferences(
    references,
    range.start,
    range.end,
    insertLength,
    insertLength - deleteCount,
  );
  const insert: InlineContent[] =
    replacement.length === 0 ? [] : [{ type: "markdown", value: replacement }];
  return {
    splice: { block_id: blockId, index, delete: deleteCount, insert },
    references: nextReferences,
  };
}

/** Replaces one literal `[[…]]` token with a semantic PageId atom. */
export function planPageReference(
  blockId: string,
  before: string,
  referencesInput: readonly PageReferenceSpan[],
  fromUtf16: number,
  toUtf16: number,
  pageId: string,
  title: string,
): { value: string; caret: number; plan: InlineEditPlan } {
  const references = ordered(referencesInput);
  const tokenStart = codePointIndex(before, fromUtf16);
  const tokenEnd = codePointIndex(before, toUtf16);
  const range = expandedRange(references, tokenStart, tokenEnd);
  const points = Array.from(before);
  const prefix = points.slice(range.start, tokenStart).join("");
  const suffix = points.slice(tokenEnd, range.end).join("");
  const source = `[[${title}]]`;
  const replacement = `${prefix}${source}${suffix}`;
  const value = [
    ...points.slice(0, range.start),
    ...Array.from(replacement),
    ...points.slice(range.end),
  ].join("");
  const index = logicalBoundary(range.start, references);
  const deleteCount = logicalBoundary(range.end, references) - index;
  const prefixLength = Array.from(prefix).length;
  const suffixLength = Array.from(suffix).length;
  const insert: InlineContent[] = [];
  if (prefix) insert.push({ type: "markdown", value: prefix });
  insert.push({ type: "page_reference", page_id: pageId });
  if (suffix) insert.push({ type: "markdown", value: suffix });
  const insertLogicalLength = prefixLength + 1 + suffixLength;
  const displayLength = Array.from(replacement).length;
  const nextReferences = transformReferences(
    references,
    range.start,
    range.end,
    displayLength,
    insertLogicalLength - deleteCount,
  );
  const referenceStart = range.start + prefixLength;
  nextReferences.push({
    start: referenceStart,
    end: referenceStart + Array.from(source).length,
    index: index + prefixLength,
    page_id: pageId,
  });
  nextReferences.sort((left, right) => left.start - right.start);

  const caret = [...value].slice(0, referenceStart + Array.from(source).length).join("").length;
  return {
    value,
    caret,
    plan: {
      splice: { block_id: blockId, index, delete: deleteCount, insert },
      references: nextReferences,
    },
  };
}
