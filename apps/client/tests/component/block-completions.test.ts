import { describe, expect, it } from "vitest";
import {
  detectPage,
  filterPageOptions,
  liveCompletionAnchor,
  type BlockCompletionRequest,
} from "../../src/features/blocks/editor/BlockCompletions";

describe("completion anchors", () => {
  it("follows a pending editor to the focused canonical textarea", () => {
    const pending = document.createElement("textarea");
    const canonical = document.createElement("textarea");
    canonical.setAttribute("data-block-editor", "true");
    document.body.append(canonical);
    canonical.focus();
    const request: BlockCompletionRequest = {
      blockId: "canonical",
      start: 0,
      end: 10,
      query: "scheduled",
      anchor: pending,
    };

    expect(liveCompletionAnchor(request)).toBe(canonical);
    canonical.remove();
  });
});

describe("page reference completion", () => {
  it("owns the paired closer and allows spaces in a page query", () => {
    expect(detectPage("See [[project plan]]", 18, 18)).toEqual({
      start: 4,
      end: 20,
      query: "project plan",
    });
  });

  it("offers live pages and one explicit create choice", () => {
    expect(filterPageOptions([
      { id: "one", title: "Project Plan", journal_date: null, deleted: false },
      { id: "deleted", title: "Project Past", journal_date: null, deleted: true },
    ], "project n", (left, right) => left.localeCompare(right))).toEqual([
      { id: "one", title: "Project Plan", create: false },
      { id: "", title: "project n", create: true },
    ]);
  });

  it("does not offer a duplicate create choice for the core's normalized name", () => {
    expect(filterPageOptions([
      { id: "one", title: "Project Plan", journal_date: null, deleted: false },
    ], "  project   plan ", (left, right) => left.localeCompare(right))).toEqual([
      { id: "one", title: "Project Plan", create: false },
    ]);
  });
});
