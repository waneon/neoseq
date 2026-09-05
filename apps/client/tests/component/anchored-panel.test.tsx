// What a summoned panel does with the caret when it arrives.
//
// The frame that puts the caret on a panel's first control runs after the panel
// mounts, so a fast hand — or a machine slow enough that a press overtakes a
// frame — can open one of the panel's own dropdowns first. The frame must not
// then take the caret back: focus leaving a Radix menu closes it, so the reader
// would watch the menu they just opened shut itself.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredPanel } from "../../src/ui/anchored-panel";
import { elementAnchor, snapshotAnchor, type Anchor } from "../../src/ui/anchored";
import { MenuSelect } from "../../src/ui/menu-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../src/ui/shadcn/dropdown-menu";

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
      <button ref={anchor} type="button">
        order
      </button>
      <AnchoredPanel
        anchor={elementAnchor(anchor.current)}
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

function DismissiblePanel({ transferFocus = false }: { transferFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLInputElement>(null);
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(true)}>
        Edit value
      </button>
      <input ref={next} aria-label="Next field" />
      {open && (
        <AnchoredPanel
          anchor={elementAnchor(anchor.current)}
          label="Value"
          className="context-panel"
          onClose={() => setOpen(false)}
        >
          <button
            onClick={() => {
              setOpen(false);
              if (transferFocus) next.current?.focus();
            }}
          >
            Apply
          </button>
        </AnchoredPanel>
      )}
    </>
  );
}

function AnchorLifetime({
  present = true,
  captured = false,
}: {
  present?: boolean;
  captured?: boolean;
}) {
  const [anchor, setAnchor] = useState<Anchor>(null);
  return (
    <>
      {present && (
        <button
          onClick={(event) => {
            const live = elementAnchor(event.currentTarget);
            setAnchor(captured ? snapshotAnchor(live) : live);
          }}
        >
          Edit value
        </button>
      )}
      {anchor && (
        <AnchoredPanel
          anchor={anchor}
          label="Value"
          className="context-panel"
          onClose={() => setAnchor(null)}
        >
          <input aria-label="Value" />
        </AnchoredPanel>
      )}
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a summoned panel", () => {
  it("retains initial focus when its invoking menu closes", async () => {
    function MenuPanel() {
      const [open, setOpen] = useState(false);
      const anchor = useRef<HTMLButtonElement>(null);
      return (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger ref={anchor}>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setOpen(true)}>Edit value</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {open && (
            <AnchoredPanel
              anchor={elementAnchor(anchor.current)}
              label="Value"
              className="context-panel"
              onClose={() => setOpen(false)}
            >
              <input aria-label="Value" />
            </AnchoredPanel>
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<MenuPanel />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit value" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Value" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
  });

  it("retains an anchor moved within the same DOM commit", async () => {
    const user = userEvent.setup();
    render(<AnchorLifetime />);
    const owner = screen.getByRole("button", { name: "Edit value" });
    await user.click(owner);
    await screen.findByRole("dialog", { name: "Value" });

    await act(async () => {
      const parent = owner.parentElement!;
      owner.remove();
      parent.prepend(owner);
    });

    expect(screen.getByRole("dialog", { name: "Value" })).toBeInTheDocument();
  });

  it("dismisses when its live anchor is removed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AnchorLifetime />);
    await user.click(screen.getByRole("button", { name: "Edit value" }));
    await screen.findByRole("dialog", { name: "Value" });

    await act(async () => rerender(<AnchorLifetime present={false} />));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Value" })).not.toBeInTheDocument(),
    );
  });

  it("keeps a captured anchor after its former control is removed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AnchorLifetime captured />);
    await user.click(screen.getByRole("button", { name: "Edit value" }));
    await screen.findByRole("dialog", { name: "Value" });

    await act(async () => rerender(<AnchorLifetime present={false} captured />));

    expect(screen.getByRole("dialog", { name: "Value" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveFocus();
  });

  it("returns focus to its owner after applying a choice", async () => {
    const user = userEvent.setup();
    render(<DismissiblePanel />);

    await user.click(screen.getByRole("button", { name: "Edit value" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Edit value" })).toHaveFocus());
  });

  it("preserves a choice's explicit focus transfer", async () => {
    const user = userEvent.setup();
    render(<DismissiblePanel transferFocus />);

    await user.click(screen.getByRole("button", { name: "Edit value" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Value" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Next field" })).toHaveFocus();
  });

  it("preserves outside pointer focus when dismissed", async () => {
    const user = userEvent.setup();
    render(<DismissiblePanel />);

    await user.click(screen.getByRole("button", { name: "Edit value" }));
    await user.click(screen.getByRole("textbox", { name: "Next field" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Value" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Next field" })).toHaveFocus();
  });

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
    const term = await screen.findByRole("option", { name: "Tag" });

    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(term).toBeInTheDocument();
    const listbox = screen.getByRole("listbox", { name: "Add a term" });
    expect(listbox).toContainElement(document.activeElement as HTMLElement);
  });
});
