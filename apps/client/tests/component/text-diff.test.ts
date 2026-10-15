// Within a repeated run, typed text is attributed to where the caret put it.

import { expect, it } from "vitest";
import { diffSplice } from "../../src/features/blocks/editor/text-diff";

it("places an insertion or deletion at the caret inside a repeated run", () => {
  expect(diffSplice("one three", "one two three", 8)).toEqual({
    index: 4,
    delete: 0,
    insert: "two ",
  });
  expect(diffSplice("aaa", "aaaa", 1)).toEqual({ index: 0, delete: 0, insert: "a" });
  expect(diffSplice("aaaa", "aaa", 1)).toEqual({ index: 1, delete: 1, insert: "" });
  expect(diffSplice("aaa", "aaaa")).toEqual({ index: 3, delete: 0, insert: "a" });
});
