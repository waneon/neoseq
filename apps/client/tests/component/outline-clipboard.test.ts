import { describe, expect, it } from "vitest";
import type { OutlineRow } from "../../src/entities/outline";
import {
  buildClipboardBundle,
  createOutlineFragment,
  parseMarkdownOutline,
  readOutlineFragment,
  serializeOutlineSelection,
  setClipboardData,
} from "../../src/features/outline/clipboard";
import type { GraphSnapshot, PageSnapshot } from "../../src/core-port/snapshot";

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

  it("upgrades v1 rich fragments without discarding their metadata", () => {
    const legacy = JSON.stringify({
      kind: "neoseq.outline",
      version: 1,
      source_graph_id: "graph",
      items: [{ depth: 0, markdown: "legacy", properties: [], tags: ["project"] }],
      tags: [{ id: "project", name: "Project" }],
      pages: [],
    });
    const fragment = readOutlineFragment({
      getData: (type: string) => type === "application/vnd.neoseq.outline+json" ? legacy : "",
    });

    expect(fragment?.version).toBe(2);
    expect(fragment?.items[0].page_references).toEqual([]);
    expect(fragment?.items[0].tags).toEqual(["project"]);
  });

  it("builds a lossless fragment and readable standard representations", () => {
    const page: PageSnapshot = {
      id: "home",
      title: "Home",
      properties: [],
      tags: [],
      blocks: [{
        id: "parent",
        markdown: "ship it",
        properties: [
          {
            key: "builtin.created-at",
            value_type: "string",
            cardinality: "single",
            values: [{ type: "string", value: "old" }],
          },
          {
            key: "builtin.task-status",
            value_type: "string",
            cardinality: "single",
            values: [{ type: "string", value: "doing" }],
          },
          {
            key: "user.reviewers",
            value_type: "string",
            cardinality: "set",
            values: [],
          },
        ],
        tags: ["project"],
        children: [{
          id: "hidden-child",
          markdown: "collapsed child",
          properties: [],
          tags: [],
          children: [],
        }],
      }],
    };
    const snapshot: GraphSnapshot = {
      schema_version: 1,
      graph_id: "graph",
      pages: [page],
      tags: [{ id: "project", name: "Project", properties: [], defaults: [] }],
      quarantined: [],
    };

    const fragment = createOutlineFragment(snapshot, page, new Set(["parent"]));
    expect(fragment?.items.map((item) => [item.depth, item.markdown])).toEqual([
      [0, "ship it"],
      [1, "collapsed child"],
    ]);
    expect(fragment?.items[0].properties.map((field) => field.key)).toEqual([
      "builtin.task-status",
      "user.reviewers",
    ]);
    expect(fragment?.tags).toEqual([{ id: "project", name: "Project" }]);

    const bundle = buildClipboardBundle(fragment!);
    expect(bundle.plain).toContain("Tags: #Project");
    expect(bundle.plain).toContain("builtin.task-status:: doing");
    expect(bundle.plain).toContain("user.reviewers::");
    expect(bundle.html).toContain("data-neoseq-outline=");

    const values = new Map<string, string>();
    const clipboard = {
      setData: (type: string, value: string) => { values.set(type, value); },
      getData: (type: string) => values.get(type) ?? "",
    };
    setClipboardData(clipboard, bundle);
    expect(readOutlineFragment(clipboard)).toEqual(fragment);
  });

  it("keeps inline page identity in the v2 semantic fragment", () => {
    const target: PageSnapshot = {
      id: "roadmap",
      title: "Roadmap",
      properties: [],
      tags: [],
      blocks: [],
    };
    const page: PageSnapshot = {
      id: "home",
      title: "Home",
      properties: [],
      tags: [],
      blocks: [{
        id: "reference",
        markdown: "See [[Roadmap]]",
        page_references: [{ start: 4, end: 15, index: 4, page_id: "roadmap" }],
        properties: [],
        tags: [],
        children: [],
      }],
    };
    const snapshot = {
      schema_version: 6,
      graph_id: "graph",
      pages: [page, target],
      page_directory: [
        { id: "home", title: "Home", journal_date: null, deleted: false },
        { id: "roadmap", title: "Roadmap", journal_date: null, deleted: false },
      ],
      tags: [],
      settings: { default_queries: [] },
      quarantined: [],
    } satisfies GraphSnapshot;

    const fragment = createOutlineFragment(snapshot, page, new Set(["reference"]));
    expect(fragment?.version).toBe(2);
    expect(fragment?.items[0].page_references).toEqual(page.blocks[0].page_references);
    expect(fragment?.pages).toEqual([{
      id: "roadmap",
      title: "Roadmap",
      journal_date: null,
    }]);
  });
});
