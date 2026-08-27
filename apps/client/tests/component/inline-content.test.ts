import { describe, expect, it } from "vitest";
import type { PageReferenceSpan } from "../../src/core-port/snapshot";
import {
  canonicalContentBoundary,
  planInlineEdit,
  planPageReference,
  splitInlineContentProjection,
} from "../../src/features/blocks/editor/inline-content";

const reference: PageReferenceSpan = {
  start: 2,
  end: 10,
  index: 2,
  page_id: "page-1",
};

describe("inline content projection", () => {
  it("keeps an untouched reference atomic while text moves around it", () => {
    const plan = planInlineEdit("block", "A [[Page]] Z", [reference], "Hi A [[Page]] Z");
    expect(plan).toEqual({
      splice: {
        block_id: "block",
        index: 0,
        delete: 0,
        insert: [{ type: "markdown", value: "Hi " }],
      },
      references: [{ ...reference, start: 5, end: 13, index: 5 }],
    });
  });

  it("demotes the whole reference when its displayed title is edited", () => {
    const plan = planInlineEdit("block", "A [[Page]] Z", [reference], "A [[Pace]] Z");
    expect(plan).toEqual({
      splice: {
        block_id: "block",
        index: 2,
        delete: 1,
        insert: [{ type: "markdown", value: "[[Pace]]" }],
      },
      references: [],
    });
  });

  it("snaps structural edits away from the inside of a reference atom", () => {
    expect(canonicalContentBoundary("A [[Page]] Z", [reference], 4)).toEqual({
      index: 2,
      utf16Offset: 2,
    });
    expect(canonicalContentBoundary("A [[Page]] Z", [reference], 8)).toEqual({
      index: 3,
      utf16Offset: 10,
    });
  });

  it("re-bases reference coordinates when projecting the two sides of a split", () => {
    const beforeReference = canonicalContentBoundary("A [[Page]] Z", [reference], 2);
    expect(splitInlineContentProjection(
      "A [[Page]] Z",
      [reference],
      beforeReference,
    )).toEqual({
      head: { markdown: "A ", pageReferences: [] },
      tail: {
        markdown: "[[Page]] Z",
        pageReferences: [{ ...reference, start: 0, end: 8, index: 0 }],
      },
    });

    const afterReference = canonicalContentBoundary("A [[Page]] Z", [reference], 10);
    expect(splitInlineContentProjection(
      "A [[Page]] Z",
      [reference],
      afterReference,
    )).toEqual({
      head: { markdown: "A [[Page]]", pageReferences: [reference] },
      tail: { markdown: " Z", pageReferences: [] },
    });
  });

  it("replaces a literal completion token with one PageId atom", () => {
    const replacement = planPageReference(
      "block",
      "See [[]] next",
      [],
      4,
      8,
      "roadmap",
      "Roadmap",
    );
    expect(replacement.value).toBe("See [[Roadmap]] next");
    expect(replacement.plan.splice).toEqual({
      block_id: "block",
      index: 4,
      delete: 4,
      insert: [{ type: "page_reference", page_id: "roadmap" }],
    });
    expect(replacement.plan.references).toEqual([{
      start: 4,
      end: 15,
      index: 4,
      page_id: "roadmap",
    }]);
    expect(replacement.caret).toBe(15);
  });
});
