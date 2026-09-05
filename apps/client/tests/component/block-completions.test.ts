import { describe, expect, it } from "vitest";
import {
  detectPage,
  completionAnchor,
  filterPageOptions,
  liveCompletionAnchor,
  type BlockCompletionRequest,
} from "../../src/features/blocks/editor/BlockCompletions";

describe("completion anchors", () => {
  it("resolves replacement inside its surface before focus moves and never follows another surface", () => {
    const scope = document.createElement("div");
    const row = document.createElement("div");
    row.dataset.blockId = "canonical";
    const canonical = document.createElement("textarea");
    canonical.setAttribute("data-block-editor", "true");
    row.append(canonical);
    scope.append(row);
    const unrelated = document.createElement("textarea");
    unrelated.setAttribute("data-block-editor", "true");
    document.body.append(scope, unrelated);
    unrelated.focus();
    const pending = document.createElement("textarea");
    const request: BlockCompletionRequest = {
      blockId: "canonical",
      start: 0,
      end: 1,
      query: "",
      anchorOffset: 0,
      anchor: pending,
      scope,
    };
    expect(liveCompletionAnchor(request)).toBe(canonical);
    row.remove();
    expect(liveCompletionAnchor(request)).toBe(pending);
    scope.remove();
    unrelated.remove();
  });

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
      anchorOffset: 0,
      anchor: pending,
    };

    expect(liveCompletionAnchor(request)).toBe(canonical);
    expect(completionAnchor(request)).toEqual({
      geometry: { kind: "caret", textarea: canonical, offset: 0 },
      owner: canonical,
    });
    canonical.remove();
  });
});

describe("page reference completion", () => {
  it("owns the paired closer and allows spaces in a page query", () => {
    expect(detectPage("See [[project plan]]", 18, 18)).toEqual({
      start: 4,
      end: 20,
      query: "project plan",
      anchorOffset: 4,
    });
  });

  it("offers live pages and one explicit create choice", () => {
    expect(
      filterPageOptions(
        [
          { id: "one", title: "Project Plan", journal_date: null, deleted: false },
          { id: "deleted", title: "Project Past", journal_date: null, deleted: true },
        ],
        "project n",
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual([
      { id: "one", title: "Project Plan", create: false },
      { id: "", title: "project n", create: true },
    ]);
  });

  it("does not offer a duplicate create choice for the core's normalized name", () => {
    expect(
      filterPageOptions(
        [{ id: "one", title: "Project Plan", journal_date: null, deleted: false }],
        "  project   plan ",
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual([{ id: "one", title: "Project Plan", create: false }]);
  });
});
