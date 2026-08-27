import { createPortal } from "react-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AnchoredPanel } from "../../src/ui/anchored-panel";
import { useOverlayRoot } from "../../src/ui/overlay-root";

const ANCHOR = new DOMRect(120, 200, 240, 28);

function NestedChoice() {
  const root = useOverlayRoot();
  return createPortal(<div data-testid="nested-scroll" />, root);
}

function ContextualSurface({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="document-scroll" />
      {open && (
        <AnchoredPanel
          anchor={ANCHOR}
          label="Context"
          className="context-panel"
          testId="surface"
          dismissOnExternalScroll
          onClose={() => setOpen(false)}
        >
          <div data-testid="surface-scroll" />
          {nested && <NestedChoice />}
        </AnchoredPanel>
      )}
    </>
  );
}

describe("a contextual anchored surface", () => {
  it("stays open for its own scrolling and dismisses on external scrolling", async () => {
    render(<ContextualSurface />);
    await screen.findByTestId("surface");

    fireEvent.scroll(screen.getByTestId("surface-scroll"));
    expect(screen.getByTestId("surface")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("document-scroll"));
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });

  it("keeps a nested portaled choice inside the owning surface", async () => {
    render(<ContextualSurface nested />);
    const surface = await screen.findByTestId("surface");
    const nested = await screen.findByTestId("nested-scroll");
    expect(surface).toContainElement(nested);

    fireEvent.scroll(nested);
    expect(screen.getByTestId("surface")).toBeInTheDocument();
  });
});
