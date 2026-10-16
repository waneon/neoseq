// A canonical change that arrives without its own mapping still moves a draft.

import { describe, expect, it } from "vitest";
import {
  contentAtoms,
  createContentBuffer,
  diffContent,
  projectBuffer,
  rebaseBuffer,
  rebaseOnto,
  spliceBuffer,
} from "../../src/features/blocks/editor/content-buffer";

const text = (value: string) => [{ type: "markdown" as const, value }];
const atoms = (value: string) => contentAtoms(text(value));
const markdown = (buffer: Parameters<typeof projectBuffer>[0]) =>
  projectBuffer(buffer, []).markdown;

describe("content diff", () => {
  it("maps any content onto any other and keeps a longest common run", () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const word = () => Array.from({ length: next() % 12 }, () => "abc"[next() % 3]).join("");
    for (let round = 0; round < 300; round += 1) {
      const before = word();
      const after = word();
      const changes = diffContent(atoms(before), atoms(after));
      const moved = rebaseBuffer(createContentBuffer(text(before)), text(after), changes);
      expect(moved && markdown(moved.buffer), `${before} -> ${after}`).toBe(after);
      const replaced = changes.reduce((sum, change) => sum + change.delete, 0);
      expect(before.length - replaced, `${before} -> ${after}`).toBe(lcs(before, after));
    }
  });

  it("keeps a draft's insertion beside an unmapped change before it", () => {
    const draft = spliceBuffer(createContentBuffer(text("abcdef")), 3, 0, text("L"));
    expect(markdown(rebaseOnto(draft, text("aXbcdef")).buffer)).toBe("aXbcLdef");
  });

  it("keeps a draft's deletion beside an unmapped change after it", () => {
    const draft = spliceBuffer(createContentBuffer(text("abcdef")), 2, 2, []);
    expect(markdown(rebaseOnto(draft, text("abcdefY")).buffer)).toBe("abefY");
  });

  it("prefers a mapping that starts from the draft's source", () => {
    const draft = spliceBuffer(createContentBuffer(text("aa")), 1, 0, text("L"));
    // "aa" -> "aaa" is ambiguous to a diff; the mapping says the new atom came first.
    const moved = rebaseOnto(draft, text("aaa"), [{ index: 0, delete: 0, insert: 1 }]);
    expect(markdown(moved.buffer)).toBe("aaLa");
  });
});

function lcs(left: string, right: string): number {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const char of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const above = row[index];
      row[index] = char === right[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = above;
    }
  }
  return row[right.length];
}
