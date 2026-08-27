import { describe, expect, it } from "vitest";
import { applyAcknowledgedContentSplices } from "../../src/core-port/content-patch";
import type { GraphSnapshot } from "../../src/core-port/snapshot";

const snapshot: GraphSnapshot = {
  schema_version: 6,
  graph_id: "graph",
  pages: [{
    id: "home",
    title: "Home",
    properties: [],
    tags: [],
    blocks: [{
      id: "block",
      markdown: "See [[Old]] now",
      page_references: [{ start: 4, end: 11, index: 4, page_id: "target" }],
      properties: [],
      tags: [],
      children: [],
    }],
  }, {
    id: "target",
    title: "New title",
    properties: [],
    tags: [],
    blocks: [],
  }],
  page_directory: [
    { id: "home", title: "Home", journal_date: null, deleted: false },
    { id: "target", title: "New title", journal_date: null, deleted: false },
  ],
  tags: [],
  settings: { default_queries: [] },
  quarantined: [],
};

describe("acknowledged content patches", () => {
  it("updates one canonical atom sequence without replacing its siblings", () => {
    const result = applyAcknowledgedContentSplices(
      snapshot,
      { kind: "page", id: "home" },
      [{ block_id: "block", index: 0, delete: 3, insert: [{ type: "markdown", value: "Read" }] }],
    );

    expect(result?.pages[0].blocks[0].markdown).toBe("Read [[New title]] now");
    expect(result?.pages[0].blocks[0].page_references).toEqual([{
      start: 5,
      end: 18,
      index: 5,
      page_id: "target",
    }]);
    expect(result?.pages[1]).toBe(snapshot.pages[1]);
  });

  it("falls back when the hydrated block cannot accept the command", () => {
    expect(applyAcknowledgedContentSplices(
      snapshot,
      { kind: "page", id: "home" },
      [{ block_id: "missing", index: 0, delete: 0, insert: [] }],
    )).toBeNull();
  });
});
