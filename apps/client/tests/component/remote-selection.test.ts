import { transformProjectedSelection } from "../../src/features/blocks/editor/selection";

function change(
  before: string,
  after: string,
  mapping: { index: number; delete: number; insert: number }[],
) {
  return {
    before: Array.from(before),
    after: Array.from(after),
    mapping,
    beforeDirectory: [],
    afterDirectory: [],
  };
}

describe("native selection across canonical changes", () => {
  it("moves a native caret after an insertion containing an emoji", () => {
    expect(
      transformProjectedSelection(
        change("hello world", "hello 🦀 world", [{ index: 6, delete: 0, insert: 2 }]),
        { anchor: 11, head: 11 },
      ),
    ).toEqual({ anchor: 14, head: 14 });
  });

  it("keeps the direction of a selection across a replacement", () => {
    expect(
      transformProjectedSelection(
        change("hello world", "hellXorld", [{ index: 4, delete: 3, insert: 1 }]),
        { anchor: 11, head: 4 },
      ),
    ).toEqual({ anchor: 9, head: 4 });
  });

  it("preserves a native caret between disjoint changes", () => {
    expect(
      transformProjectedSelection(
        change("abcdef", "aXbcdYef", [
          { index: 1, delete: 0, insert: 1 },
          { index: 5, delete: 0, insert: 1 },
        ]),
        { anchor: 3, head: 3 },
      ),
    ).toEqual({ anchor: 4, head: 4 });
  });
});
