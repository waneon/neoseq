import type { BlockContentSplice, Command, InlineContent } from "../../../core-port/commands";
import type {
  ContentRangeChange,
  OutlineOwner,
  PageDirectoryEntry,
  PageReferenceSpan,
} from "../../../core-port/snapshot";
import { projectInlineContent } from "../../../core-port/snapshot";
import { planInlineEdit, type InlineContentProjection } from "./inline-content";

/** One Unicode scalar or one semantic reference. Display titles are never stored here. */
export type ContentAtom = string | { readonly page_id: string };

type Piece =
  | { readonly kind: "source"; readonly from: number; readonly to: number }
  | { readonly kind: "insert"; readonly atoms: readonly ContentAtom[] };

/**
 * A draft is an edit of a semantic source. Source pieces retain the identity of
 * untouched content; inserted pieces contain only newly authored content.
 * Markdown and reference offsets are disposable projections of these pieces.
 */
export interface ContentBuffer {
  readonly source: readonly ContentAtom[];
  readonly pieces: readonly Piece[];
}

export interface ContentChange {
  readonly from: number;
  readonly to: number;
  readonly insert: readonly ContentAtom[];
}

export function contentAtoms(content: readonly InlineContent[]): ContentAtom[] {
  return content.flatMap<ContentAtom>((item) =>
    item.type === "markdown" ? Array.from(item.value) : [{ page_id: item.page_id }],
  );
}

export function inlineContent(atoms: readonly ContentAtom[]): InlineContent[] {
  const content: InlineContent[] = [];
  for (const atom of atoms) {
    if (typeof atom !== "string") {
      content.push({ type: "page_reference", page_id: atom.page_id });
      continue;
    }
    const previous = content.at(-1);
    if (previous?.type === "markdown") previous.value += atom;
    else content.push({ type: "markdown", value: atom });
  }
  return content;
}

export function createContentBuffer(content: readonly InlineContent[]): ContentBuffer {
  const source = contentAtoms(content);
  return { source, pieces: source.length ? [{ kind: "source", from: 0, to: source.length }] : [] };
}

/** Used only at browser/clipboard projection boundaries, never to reconcile a draft. */
export function contentFromProjection(
  markdown: string,
  references: readonly PageReferenceSpan[],
): InlineContent[] {
  const points = Array.from(markdown);
  const content: InlineContent[] = [];
  let from = 0;
  for (const reference of references) {
    if (reference.start < from || reference.end > points.length) continue;
    if (from < reference.start) {
      content.push({ type: "markdown", value: points.slice(from, reference.start).join("") });
    }
    content.push({ type: "page_reference", page_id: reference.page_id });
    from = reference.end;
  }
  if (from < points.length) content.push({ type: "markdown", value: points.slice(from).join("") });
  return content;
}

function pieceLength(piece: Piece): number {
  return piece.kind === "source" ? piece.to - piece.from : piece.atoms.length;
}

export function bufferAtoms(buffer: ContentBuffer): ContentAtom[] {
  return buffer.pieces.flatMap((piece) =>
    piece.kind === "source" ? buffer.source.slice(piece.from, piece.to) : [...piece.atoms],
  );
}

export function projectContent(
  atoms: readonly ContentAtom[],
  directory: readonly PageDirectoryEntry[],
): InlineContentProjection {
  return projectInlineContent(inlineContent(atoms), directory);
}

const projections = new WeakMap<
  ContentBuffer,
  WeakMap<readonly PageDirectoryEntry[], InlineContentProjection>
>();
export function projectBuffer(
  buffer: ContentBuffer,
  directory: readonly PageDirectoryEntry[],
): InlineContentProjection {
  let byDirectory = projections.get(buffer);
  if (!byDirectory) {
    byDirectory = new WeakMap();
    projections.set(buffer, byDirectory);
  }
  let projection = byDirectory.get(directory);
  if (!projection) {
    projection = projectContent(bufferAtoms(buffer), directory);
    byDirectory.set(directory, projection);
  }
  return projection;
}

function slicePieces(pieces: readonly Piece[], from: number, to: number): Piece[] {
  const sliced: Piece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const length = pieceLength(piece);
    const start = Math.max(0, from - offset);
    const end = Math.min(length, to - offset);
    if (start < end) {
      sliced.push(
        piece.kind === "source"
          ? { kind: "source", from: piece.from + start, to: piece.from + end }
          : { kind: "insert", atoms: piece.atoms.slice(start, end) },
      );
    }
    offset += length;
    if (offset >= to) break;
  }
  return sliced;
}

function compactPieces(pieces: readonly Piece[]): Piece[] {
  const compact: Piece[] = [];
  for (const piece of pieces) {
    if (pieceLength(piece) === 0) continue;
    const previous = compact.at(-1);
    if (previous?.kind === "source" && piece.kind === "source" && previous.to === piece.from) {
      compact[compact.length - 1] = { ...previous, to: piece.to };
    } else if (previous?.kind === "insert" && piece.kind === "insert") {
      compact[compact.length - 1] = { kind: "insert", atoms: [...previous.atoms, ...piece.atoms] };
    } else compact.push(piece);
  }
  return compact;
}

export function spliceBuffer(
  buffer: ContentBuffer,
  index: number,
  remove: number,
  insert: readonly InlineContent[],
): ContentBuffer {
  const length = buffer.pieces.reduce((size, piece) => size + pieceLength(piece), 0);
  if (index < 0 || remove < 0 || index + remove > length) {
    throw new RangeError("Content edit is outside its source");
  }
  return {
    source: buffer.source,
    pieces: compactPieces([
      ...slicePieces(buffer.pieces, 0, index),
      { kind: "insert", atoms: contentAtoms(insert) },
      ...slicePieces(buffer.pieces, index + remove, length),
    ]),
  };
}

/** Native input is decoded against exactly the projection that received it. */
export function editBuffer(
  buffer: ContentBuffer,
  projection: InlineContentProjection,
  value: string,
): ContentBuffer {
  const plan = planInlineEdit("", projection.markdown, projection.pageReferences, value);
  return plan
    ? spliceBuffer(buffer, plan.splice.index, plan.splice.delete, plan.splice.insert)
    : buffer;
}

export function bufferChanges(buffer: ContentBuffer): ContentChange[] {
  const changes: ContentChange[] = [];
  let from = 0;
  let insert: ContentAtom[] = [];
  for (const piece of buffer.pieces) {
    if (piece.kind === "insert") {
      insert = [...insert, ...piece.atoms];
      continue;
    }
    if (from < piece.from || insert.length > 0) changes.push({ from, to: piece.from, insert });
    from = piece.to;
    insert = [];
  }
  if (from < buffer.source.length || insert.length > 0) {
    changes.push({ from, to: buffer.source.length, insert });
  }
  return changes;
}

export function bufferSplices(buffer: ContentBuffer, blockId: string): BlockContentSplice[] {
  let delta = 0;
  return bufferChanges(buffer).map((change) => {
    const splice = {
      block_id: blockId,
      index: change.from + delta,
      delete: change.to - change.from,
      insert: inlineContent(change.insert),
    };
    delta += change.insert.length - splice.delete;
    return splice;
  });
}

export function bufferCommand(
  buffer: ContentBuffer,
  owner: OutlineOwner,
  blockId: string,
): Command | null {
  if (bufferIsClean(buffer)) return null;
  const splices = bufferSplices(buffer, blockId);
  return splices.length === 1
    ? { type: "splice_block_content", owner, ...splices[0] }
    : { type: "splice_block_contents", owner, splices };
}

/** Reattach input typed after a submission to the original, unaccepted source. */
export function restoreBuffer(original: ContentBuffer, newer: ContentBuffer): ContentBuffer {
  let result = original;
  for (const splice of bufferSplices(newer, "")) {
    result = spliceBuffer(result, splice.index, splice.delete, splice.insert);
  }
  return result;
}

export function settleBuffer(buffer: ContentBuffer): ContentBuffer {
  return createContentBuffer(inlineContent(bufferAtoms(buffer)));
}

export function sameContent(left: readonly ContentAtom[], right: readonly ContentAtom[]): boolean {
  return (
    left.length === right.length &&
    left.every((atom, index) => {
      const other = right[index];
      return typeof atom === "string"
        ? atom === other
        : typeof other !== "string" && atom.page_id === other.page_id;
    })
  );
}

export function bufferIsClean(buffer: ContentBuffer): boolean {
  return sameContent(buffer.source, bufferAtoms(buffer));
}

export function mapContentPosition(
  position: number,
  changes: readonly ContentRangeChange[],
  affinity: "before" | "after" = "after",
): number {
  for (const change of changes) {
    if (position < change.index || (position === change.index && affinity === "before")) continue;
    if (position >= change.index + change.delete) position += change.insert - change.delete;
    else position = change.index + (affinity === "after" ? change.insert : 0);
  }
  return position;
}

function changesFromOrigins(
  length: number,
  origins: readonly (number | null)[],
): ContentRangeChange[] {
  const changes: ContentRangeChange[] = [];
  let cursor = 0;
  let insert = 0;
  let delta = 0;
  const emit = (to: number) => {
    if (cursor < to || insert > 0) {
      changes.push({ index: cursor + delta, delete: to - cursor, insert });
      delta += insert - (to - cursor);
    }
    insert = 0;
  };
  for (const origin of origins) {
    if (origin === null) insert += 1;
    else {
      emit(origin);
      cursor = origin + 1;
    }
  }
  emit(length);
  return changes;
}

/**
 * Rebase authored pieces through actual canonical changes. A local deletion
 * removes only source atoms it observed, so a concurrent insertion inside that
 * range survives. The returned mapping also tracks the visible local draft.
 */
export function rebaseBuffer(
  buffer: ContentBuffer,
  content: readonly InlineContent[],
  mapping: readonly ContentRangeChange[],
): { buffer: ContentBuffer; mapping: ContentRangeChange[] } | null {
  const source = contentAtoms(content);
  let origins: Array<number | null> = buffer.source.map((_, index) => index);
  for (const change of mapping) {
    if (change.index < 0 || change.delete < 0 || change.index + change.delete > origins.length)
      return null;
    origins = [
      ...origins.slice(0, change.index),
      ...Array<number | null>(change.insert).fill(null),
      ...origins.slice(change.index + change.delete),
    ];
  }
  if (origins.length !== source.length) return null;
  if (
    origins.some(
      (origin, index) => origin !== null && !sameContent([buffer.source[origin]], [source[index]]),
    )
  )
    return null;

  const originalVisible = new Map<number, number>();
  const insertedVisible: number[] = [];
  let visible = 0;
  for (const piece of buffer.pieces) {
    if (piece.kind === "source") {
      for (let index = piece.from; index < piece.to; index += 1)
        originalVisible.set(index, visible++);
    } else for (const _ of piece.atoms) insertedVisible.push(visible++);
  }
  const insertions = new Map<number, { atoms: ContentAtom[]; origins: number[] }>();
  let insertedOffset = 0;
  for (const change of bufferChanges(buffer)) {
    if (change.insert.length === 0) continue;
    const at = mapContentPosition(change.from, mapping);
    const previous = insertions.get(at) ?? { atoms: [], origins: [] };
    previous.atoms = previous.atoms.concat(change.insert);
    previous.origins = previous.origins.concat(
      insertedVisible.slice(insertedOffset, insertedOffset + change.insert.length),
    );
    insertedOffset += change.insert.length;
    insertions.set(at, previous);
  }
  const pieces: Piece[] = [];
  const visibleOrigins: Array<number | null> = [];
  for (let index = 0; index <= source.length; index += 1) {
    const insertion = insertions.get(index);
    if (insertion) {
      pieces.push({ kind: "insert", atoms: insertion.atoms });
      for (const origin of insertion.origins) visibleOrigins.push(origin);
    }
    if (index === source.length) break;
    const origin = origins[index];
    if (origin !== null && !originalVisible.has(origin)) continue;
    pieces.push({ kind: "source", from: index, to: index + 1 });
    visibleOrigins.push(origin === null ? null : originalVisible.get(origin)!);
  }
  return {
    buffer: { source, pieces: compactPieces(pieces) },
    mapping: changesFromOrigins(visible, visibleOrigins),
  };
}
