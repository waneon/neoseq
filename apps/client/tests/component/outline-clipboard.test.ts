import { describe, expect, it } from "vitest";
import {
  buildClipboardBundle,
  createOutlineFragment,
  decodeOutlineClipboard,
  parseHtmlOutline,
  parseMarkdownOutline,
  readOutlineFragment,
  setClipboardData,
} from "../../src/features/outline/clipboard";
import type { OutlineFragment } from "../../src/core-port/fragment";
import type { GraphSnapshot, PageSnapshot } from "../../src/core-port/snapshot";

function fragment(items: readonly { depth: number; markdown: string }[]): OutlineFragment {
  return {
    kind: "neoseq.outline",
    version: 2,
    source_graph_id: "graph",
    items: items.map((item) => ({ ...item, page_references: [], properties: [], tags: [] })),
    tags: [],
    pages: [],
  };
}

describe("outline clipboard codecs", () => {
  it("serializes normalized fragment depth as portable Markdown", () => {
    const bundle = buildClipboardBundle(fragment([
      { depth: 0, markdown: "parent" },
      { depth: 1, markdown: "child\ncontinuation" },
    ]));
    expect(bundle.plain).toBe(
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

  it("parses semantic HTML lists independently of application wrappers", () => {
    const html = `
      <div class="c-message__body">
        <ul data-stringify-type="unordered-list">
          <li><p>Plan <strong>today</strong></p>
            <ol><li><div>Ship<br>carefully</div></li></ol>
          </li>
          <li><span>Review</span></li>
        </ul>
      </div>
    `;

    expect(parseHtmlOutline(html)).toEqual([
      { depth: 0, markdown: "Plan **today**" },
      { depth: 1, markdown: "Ship\ncarefully" },
      { depth: 0, markdown: "Review" },
    ]);
  });

  it("accepts portable Unicode bullets when rich HTML is unavailable", () => {
    expect(parseMarkdownOutline("• one\n  ◦ two\n• three")).toEqual([
      { depth: 0, markdown: "one" },
      { depth: 1, markdown: "two" },
      { depth: 0, markdown: "three" },
    ]);
  });

  it("prefers semantic HTML over a lossy plain-text projection", () => {
    const values = new Map([
      ["text/html", "<ol><li>one<ul><li>two</li></ul></li></ol>"],
      ["text/plain", "one\ntwo"],
    ]);
    expect(decodeOutlineClipboard({
      getData: (type: string) => values.get(type) ?? "",
    })).toEqual({
      kind: "outline",
      source: "html",
      items: [
        { depth: 0, markdown: "one" },
        { depth: 1, markdown: "two" },
      ],
    });
  });

  it("does not discard prose surrounding an HTML list", () => {
    expect(parseHtmlOutline("<p>Introduction</p><ul><li>one</li></ul>")).toBeNull();
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

    const document = new DOMParser().parseFromString(bundle.html, "text/html");
    expect(document.querySelectorAll("li")).toHaveLength(2);
    expect([...document.querySelectorAll("ul, ol")].every(
      (list) => [...list.children].some((child) => child.tagName === "LI"),
    )).toBe(true);
    expect(bundle.html).not.toContain("<ul></ul>");
    expect(parseHtmlOutline(bundle.html)).toEqual([
      { depth: 0, markdown: "ship it" },
      { depth: 1, markdown: "collapsed child" },
    ]);

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
