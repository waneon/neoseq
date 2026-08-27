import { describe, expect, it } from "vitest";
import {
  elementAnchor,
  measureAnchor,
  pointAnchor,
  rectAnchor,
  snapshotAnchor,
} from "../../src/ui/anchored";

describe("snapshotAnchor", () => {
  it("captures a live element before reconciliation detaches it", () => {
    const element = document.createElement("textarea");
    const box = new DOMRect(120, 600, 80, 24);
    element.getBoundingClientRect = () => box;
    document.body.append(element);

    const live = elementAnchor(element);
    const captured = snapshotAnchor(live);
    expect(measureAnchor(captured)).toBe(box);
    expect(captured?.owner).toBe(element);
    element.remove();
    expect(measureAnchor(live)).toBeNull();
  });

  it("rejects a zero-area box instead of treating the viewport origin as an anchor", () => {
    expect(snapshotAnchor(rectAnchor(new DOMRect(0, 0, 0, 0)))).toBeNull();
  });

  it("represents a pointer as point-like geometry without losing its focus owner", () => {
    const owner = document.createElement("button");
    const anchor = pointAnchor(320, 240, owner);

    expect(measureAnchor(anchor)).toEqual(DOMRect.fromRect({ x: 320, y: 240, width: 1, height: 1 }));
    expect(anchor.owner).toBe(owner);
  });
});
