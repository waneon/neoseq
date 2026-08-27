import { describe, expect, it } from "vitest";
import { snapshotAnchor } from "../../src/ui/anchored";

describe("snapshotAnchor", () => {
  it("captures a live element before reconciliation detaches it", () => {
    const element = document.createElement("textarea");
    const box = new DOMRect(120, 600, 80, 24);
    element.getBoundingClientRect = () => box;
    document.body.append(element);

    expect(snapshotAnchor(element)).toBe(box);
    element.remove();
    expect(snapshotAnchor(element)).toBeNull();
  });

  it("rejects a zero-area box instead of treating the viewport origin as an anchor", () => {
    expect(snapshotAnchor(new DOMRect(0, 0, 0, 0))).toBeNull();
  });
});
