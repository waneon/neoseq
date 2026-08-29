import { describe, expect, it } from "vitest";
import type { GraphSnapshot, GraphSummary } from "../../src/core-port/snapshot";
import { mergeSummary } from "../../src/core-port/snapshot";

describe("graph summary projection", () => {
  it("rematerializes every hydrated reference when a page title changes", () => {
    const current: GraphSnapshot = {
      schema_version: 6,
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
              markdown: "See [[Old]] now",
              page_references: [{ start: 4, end: 11, index: 4, page_id: "target" }],
              properties: [],
              tags: [],
              children: [],
            },
          ],
        },
        {
          id: "target",
          title: "Old",
          properties: [],
          tags: [],
          blocks: [],
        },
      ],
      page_directory: [
        { id: "home", title: "Home", journal_date: null, deleted: false },
        { id: "target", title: "Old", journal_date: null, deleted: false },
      ],
      tags: [],
      settings: { default_queries: [] },
      quarantined: [],
    };
    const summary: GraphSummary = {
      ...current,
      pages: current.pages.map(({ blocks: _blocks, ...page }) => page),
      page_directory: [
        { id: "home", title: "Home", journal_date: null, deleted: false },
        { id: "target", title: "Longer title", journal_date: null, deleted: false },
      ],
      tags: [],
    };

    const merged = mergeSummary(summary, current);
    expect(merged.pages[0].blocks[0].markdown).toBe("See [[Longer title]] now");
    expect(merged.pages[0].blocks[0].page_references).toEqual([
      {
        start: 4,
        end: 20,
        index: 4,
        page_id: "target",
      },
    ]);
  });

  it("preserves unrelated hydrated block identities", () => {
    const untouched = {
      id: "plain",
      markdown: "No references here",
      page_references: [],
      properties: [],
      tags: [],
      children: [],
    };
    const current: GraphSnapshot = {
      schema_version: 6,
      graph_id: "graph",
      pages: [
        {
          id: "home",
          title: "Home",
          properties: [],
          tags: [],
          blocks: [untouched],
        },
      ],
      page_directory: [{ id: "home", title: "Home", journal_date: null, deleted: false }],
      tags: [],
      settings: { default_queries: [] },
      quarantined: [],
    };
    const summary: GraphSummary = {
      ...current,
      pages: current.pages.map(({ blocks: _blocks, ...page }) => page),
      page_directory: [{ id: "home", title: "Renamed", journal_date: null, deleted: false }],
      tags: [],
    };

    const merged = mergeSummary(summary, current);

    expect(merged.pages[0].blocks[0]).toBe(untouched);
  });
});
