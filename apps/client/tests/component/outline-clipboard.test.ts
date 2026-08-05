import { describe, expect, it } from "vitest";
import type { OutlineRow } from "../../src/entities/outline";
import {
  parseMarkdownOutline,
  serializeOutlineSelection,
} from "../../src/features/outline/clipboard";

function row(id: string, markdown: string, depth: number): OutlineRow {
  return {
    block: { id, markdown, properties: [], tags: [], children: [] },
    depth,
    parentId: null,
    index: 0,
    siblingCount: 1,
    hasChildren: false,
    collapsed: false,
  };
}

describe("outline clipboard Markdown", () => {
  it("copies covered descendants and normalizes their indentation", () => {
    const rows = [
      row("before", "before", 0),
      row("parent", "parent", 1),
      row("child", "child\ncontinuation", 2),
      row("after", "after", 1),
    ];

    expect(serializeOutlineSelection(rows, new Set(["parent"]))).toBe(
      "- parent\n  - child\n    continuation",
    );
  });

  it("parses unordered and ordered items while preserving multiline content", () => {
    expect(parseMarkdownOutline("- one\n  1. two\n     more\n  * three\n- four")).toEqual([
      { depth: 0, markdown: "one" },
      { depth: 1, markdown: "two\nmore" },
      { depth: 1, markdown: "three" },
      { depth: 0, markdown: "four" },
    ]);
  });

  it("leaves ordinary multiline text to the browser", () => {
    expect(parseMarkdownOutline("one\ntwo")).toBeNull();
    expect(parseMarkdownOutline("- one\ntwo")).toBeNull();
  });
});
