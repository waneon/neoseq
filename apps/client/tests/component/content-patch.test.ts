import { describe, expect, it } from "vitest";
import { applyContentUpdates } from "../../src/core-port/content-patch";
import {
  EMPTY_SNAPSHOT,
  type BlockContentUpdate,
  type GraphSnapshot,
} from "../../src/core-port/snapshot";

const snapshot: GraphSnapshot = {
  ...EMPTY_SNAPSHOT,
  graph_id: "graph",
  pages: [
    {
      id: "home",
      title: "Home",
      properties: [],
      tags: [],
      blocks: [
        {
          id: "block",
          content: [
            { type: "markdown", value: "See " },
            { type: "page_reference", page_id: "target" },
          ],
          markdown: "See [[Old]]",
          page_references: [{ start: 4, end: 11, index: 4, page_id: "target" }],
          properties: [],
          tags: ["topic"],
          children: [],
        },
        {
          id: "sibling",
          content: [{ type: "markdown", value: "Sibling" }],
          markdown: "Sibling",
          properties: [],
          tags: [],
          children: [],
        },
      ],
    },
    {
      id: "target",
      title: "Directory title",
      properties: [],
      tags: [],
      blocks: [],
    },
  ],
  page_directory: [
    { id: "home", title: "Home", journal_date: null, deleted: false },
    { id: "target", title: "Directory title", journal_date: null, deleted: false },
  ],
};

const update: BlockContentUpdate = {
  owner: { kind: "page", id: "home" },
  block_id: "block",
  content: [
    { type: "markdown", value: "Read " },
    { type: "page_reference", page_id: "target" },
  ],
  markdown: "Read [[Core title]]",
  page_references: [{ start: 5, end: 19, index: 5, page_id: "target" }],
  properties: [
    {
      key: "builtin.updated-at",
      value_type: "string",
      cardinality: "single",
      values: [{ type: "string", value: "core timestamp" }],
    },
  ],
  mapping: [{ index: 0, delete: 3, insert: 4 }],
};

describe("authoritative content publications", () => {
  it("installs the core's content, display and properties without interpreting its command", () => {
    const result = applyContentUpdates(snapshot, [update]);
    const block = result.pages[0].blocks[0];
    expect(block.content).toBe(update.content);
    expect(block.markdown).toBe("Read [[Core title]]");
    expect(block.page_references).toBe(update.page_references);
    expect(block.properties).toBe(update.properties);
    expect(block.tags).toBe(snapshot.pages[0].blocks[0].tags);
    expect(result.pages[0].blocks[1]).toBe(snapshot.pages[0].blocks[1]);
    expect(result.pages[1]).toBe(snapshot.pages[1]);
    expect(result.page_directory).toBe(snapshot.page_directory);
    expect(result.tags).toBe(snapshot.tags);
    expect(snapshot.pages[0].blocks[0].markdown).toBe("See [[Old]]");
  });

  it("does not manufacture rows for an unhydrated owner or a missing block", () => {
    expect(
      applyContentUpdates(snapshot, [{ ...update, owner: { kind: "page", id: "target" } }]),
    ).toBe(snapshot);
    expect(applyContentUpdates(snapshot, [{ ...update, block_id: "missing" }])).toBe(snapshot);
    expect(applyContentUpdates(snapshot, [])).toBe(snapshot);
  });
});
