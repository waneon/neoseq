// What a summoned panel does with the caret when it arrives.
//
// The frame that puts the caret on a panel's first control runs after the panel
// mounts, so a fast hand — or a machine slow enough that a press overtakes a
// frame — can open one of the panel's own dropdowns first. The frame must not
// then take the caret back: focus leaving a Radix menu closes it, so the reader
// would watch the menu they just opened shut itself.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredPanel } from "../../src/ui/anchored-panel";
import { MenuSelect } from "../../src/ui/menu-select";

/** Holds the arrival frame so a test can decide what happens before it runs. */
function heldFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return frames;
}

function Panel() {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">order</button>
      <AnchoredPanel
        anchor={anchor.current}
        className="query-sort-panel"
        label="Order"
        testId="panel"
        onClose={() => {}}
      >
        <button type="button">clear</button>
        <MenuSelect
          className="query-sort-add"
          value=""
          label="Add a term"
          placeholder="Add a term"
          testId="add"
          options={[{ value: "tag", label: "Tag" }]}
          onValueChange={() => {}}
        />
      </AnchoredPanel>
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a summoned panel", () => {
  it("puts the caret on its first control when it arrives", async () => {
    const frames = heldFrames();
    render(<Panel />);
    await screen.findByTestId("panel");

    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(screen.getByRole("button", { name: "clear" })).toHaveFocus();
  });

  it("leaves the caret in a dropdown the reader opened before the frame ran", async () => {
    const frames = heldFrames();
    render(<Panel />);
    await screen.findByTestId("panel");
    fireEvent.pointerDown(screen.getByTestId("add"), { button: 0, pointerType: "mouse" });
    const term = await screen.findByRole("menuitemradio", { name: "Tag" });

    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(term).toBeInTheDocument();
    const menu = screen.getByRole("menu", { name: "Add a term" });
    expect(menu).toContainElement(document.activeElement as HTMLElement);
  });
});
