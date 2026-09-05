import { describe, expect, it } from "vitest";
import {
  bufferAtoms,
  bufferIsClean,
  bufferSplices,
  createContentBuffer,
  editBuffer,
  projectBuffer,
  rebaseBuffer,
  settleBuffer,
  spliceBuffer,
} from "../../src/features/blocks/editor/content-buffer";

const directory = [{ id: "page", title: "Roadmap", journal_date: null, deleted: false }];

describe("semantic content buffer", () => {
  it("projects a renamed page through dirty text without rewriting an edit", () => {
    const source = createContentBuffer([
      { type: "markdown", value: "See " },
      { type: "page_reference", page_id: "page" },
    ]);
    const dirty = editBuffer(source, projectBuffer(source, directory), "See [[Roadmap]] soon");
    expect(projectBuffer(dirty, [{ ...directory[0], title: "Plan" }]).markdown).toBe(
      "See [[Plan]] soon",
    );
    expect(bufferSplices(dirty, "block")).toEqual([
      { block_id: "block", index: 5, delete: 0, insert: [{ type: "markdown", value: " soon" }] },
    ]);
  });

  it("keeps untouched source between separate edits instead of replacing its span", () => {
    let buffer = createContentBuffer([{ type: "markdown", value: "abcdef" }]);
    buffer = spliceBuffer(buffer, 1, 0, [{ type: "markdown", value: "X" }]);
    buffer = spliceBuffer(buffer, 5, 0, [{ type: "markdown", value: "Y" }]);
    expect(projectBuffer(buffer, []).markdown).toBe("aXbcdYef");
    expect(bufferSplices(buffer, "block")).toEqual([
      { block_id: "block", index: 1, delete: 0, insert: [{ type: "markdown", value: "X" }] },
      { block_id: "block", index: 5, delete: 0, insert: [{ type: "markdown", value: "Y" }] },
    ]);
  });

  it("composes changes inside new text and cancels an inserted fragment", () => {
    let buffer = createContentBuffer([{ type: "markdown", value: "ab" }]);
    buffer = spliceBuffer(buffer, 1, 0, [{ type: "markdown", value: "new" }]);
    buffer = spliceBuffer(buffer, 2, 1, [{ type: "markdown", value: "o" }]);
    expect(projectBuffer(buffer, []).markdown).toBe("anowb");
    buffer = spliceBuffer(buffer, 1, 3, []);
    expect(bufferSplices(buffer, "block")).toEqual([]);
    expect(bufferIsClean(buffer)).toBe(true);
  });

  it("demotes only the reference actually edited by the native input", () => {
    const source = createContentBuffer([
      { type: "page_reference", page_id: "page" },
      { type: "markdown", value: " / " },
      { type: "page_reference", page_id: "page" },
    ]);
    const dirty = editBuffer(source, projectBuffer(source, directory), "[[Roadzap]] / [[Roadmap]]");
    const projection = projectBuffer(dirty, [{ ...directory[0], title: "Plan" }]);
    expect(projection.markdown).toBe("[[Roadzap]] / [[Plan]]");
    expect(projection.pageReferences).toHaveLength(1);
    expect(bufferSplices(dirty, "block")[0]).toMatchObject({ index: 0, delete: 1 });
  });

  it("settles an immutable sent source without consuming subsequently typed text", () => {
    let buffer = createContentBuffer([{ type: "markdown", value: "😀" }]);
    buffer = spliceBuffer(buffer, 1, 0, [{ type: "markdown", value: " first" }]);
    const sent = settleBuffer(buffer);
    const newer = spliceBuffer(sent, bufferAtoms(sent).length, 0, [
      { type: "markdown", value: " later" },
    ]);
    expect(bufferIsClean(sent)).toBe(true);
    expect(bufferSplices(newer, "block")).toEqual([
      { block_id: "block", index: 7, delete: 0, insert: [{ type: "markdown", value: " later" }] },
    ]);
  });

  it("rebases a local deletion without deleting concurrently inserted atoms", () => {
    const source = createContentBuffer([{ type: "markdown", value: "abcdef" }]);
    const local = spliceBuffer(source, 1, 4, [{ type: "markdown", value: "L" }]);
    const rebased = rebaseBuffer(
      local,
      [{ type: "markdown", value: "abcXdef" }],
      [{ index: 3, delete: 0, insert: 1 }],
    );
    expect(rebased).not.toBeNull();
    expect(projectBuffer(rebased!.buffer, []).markdown).toBe("aLXf");
    expect(bufferSplices(rebased!.buffer, "block")).toEqual([
      { block_id: "block", index: 1, delete: 2, insert: [{ type: "markdown", value: "L" }] },
      { block_id: "block", index: 3, delete: 2, insert: [] },
    ]);
  });

  it("retains exact disjoint mappings after rebasing an untouched editor", () => {
    const source = createContentBuffer([{ type: "markdown", value: "abcdef" }]);
    const mapping = [
      { index: 1, delete: 0, insert: 1 },
      { index: 5, delete: 0, insert: 1 },
    ];
    expect(
      rebaseBuffer(source, [{ type: "markdown", value: "aXbcdYef" }], mapping)?.mapping,
    ).toEqual(mapping);
  });

  it("uses operation identity even when a replacement has identical text", () => {
    const source = createContentBuffer([{ type: "markdown", value: "abc" }]);
    const local = spliceBuffer(source, 1, 1, []);
    const rebased = rebaseBuffer(
      local,
      [{ type: "markdown", value: "abc" }],
      [{ index: 1, delete: 1, insert: 1 }],
    );
    expect(projectBuffer(rebased!.buffer, []).markdown).toBe("abc");
    expect(bufferIsClean(rebased!.buffer)).toBe(true);
  });
});
