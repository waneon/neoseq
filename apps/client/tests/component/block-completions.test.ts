import { describe, expect, it } from "vitest";
import {
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
