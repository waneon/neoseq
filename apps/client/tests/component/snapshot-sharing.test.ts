import { describe, expect, it } from "vitest";
import {
  EMPTY_SNAPSHOT,
  mergeOutline,
  sameHeaders,
  shareBlocks,
  type BlockSnapshot,
  type GraphSnapshot,
} from "../../src/core-port/snapshot";

const block = (id: string, markdown: string, children: BlockSnapshot[] = []): BlockSnapshot => ({
  id,
  content: [{ type: "markdown", value: markdown }],
  markdown,
  page_references: [],
  properties: [],
  tags: [],
  children,
});

describe("snapshot sharing", () => {
  it("keeps every block a re-read did not change", () => {
    const previous = [block("a", "one", [block("a1", "child")]), block("b", "two")];
    const unchanged = shareBlocks(previous, [
      block("a", "one", [block("a1", "child")]),
      block("b", "two"),
    ]);
    expect(unchanged).toBe(previous);

    const edited = shareBlocks(previous, [
      block("a", "one", [block("a1", "child")]),
      block("b", "edited"),
      block("c", "new"),
    ]);
    expect(edited[0]).toBe(previous[0]);
    expect(edited[1]).not.toBe(previous[1]);
    expect(edited[1].markdown).toBe("edited");
  });

  it("leaves headers equal when only an outline changes", () => {
    const page = {
      id: "home",
      title: "Home",
      properties: [],
      tags: [],
      blocks: [block("a", "one")],
    };
    const snapshot: GraphSnapshot = { ...EMPTY_SNAPSHOT, pages: [page] };
    const merged = mergeOutline(snapshot, {
      owner: { kind: "page", id: "home" },
      blocks: [block("a", "changed")],
    });
    expect(merged).not.toBe(snapshot);
    expect(sameHeaders(snapshot, merged)).toBe(true);
    expect(sameHeaders(snapshot, { ...merged, pages: [{ ...page, title: "Renamed" }] })).toBe(
      false,
    );
  });
});
