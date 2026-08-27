// The palette's two dismissal paths, both of which were reachable states with no
// way out.
//
// The palette is a modal surface with exactly one focusable element in it, and it
// is the surface a CJK user types into with an IME active. Those two facts each
// produced a way to get stuck, and neither is visible from reading the happy path.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../../src/features/commands/CommandPalette";
import { NotifyProvider } from "../../src/features/notify/context";
import { LocaleProvider } from "../../src/i18n";

function mountPalette(onClose: () => void) {
  return render(
    <LocaleProvider initialPreference="en">
      <NotifyProvider>
        <CommandPalette commands={[]} onClose={onClose} />
      </NotifyProvider>
    </LocaleProvider>,
  );
}

describe("the command palette closes", () => {
  it("on Escape while an IME composition is in progress", () => {
    const onClose = vi.fn();
    mountPalette(onClose);

    // The composition guard runs first for every other key, and must not for this
    // one. A user who typed 검색 into the search field and pressed ⎋ got nothing:
    // the browser reports `isComposing` on that keydown too, the guard returned
    // before the close path, and the only remaining way out was the pointer.
    fireEvent.keyDown(screen.getByTestId("command-input"), {
      key: "Escape",
      isComposing: true,
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on Escape after focus has left the panel", () => {
    const onClose = vi.fn();
    mountPalette(onClose);

    // The panel holds one focusable element, so ⇥ parks focus outside it and the
    // keydown never reaches the panel's own handler again.
    screen.getByTestId("command-input").blur();
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
