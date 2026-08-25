// The scroll contract of a contextual anchored surface.

import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useAnchoredPosition } from "../../src/ui/anchored";

const ANCHOR = new DOMRect(120, 200, 240, 28);

function ContextualSurface({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(true);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(
    anchor ?? ANCHOR,
    { width: 320, maxHeight: 320 },
    undefined,
    open
      ? {
          surface: surfaceRef,
          onExternalScroll: () => setOpen(false),
          exemptSelector: nested ? ".nested-choice" : undefined,
        }
      : undefined,
  );

  return (
    <>
      <div ref={setAnchor} data-testid="anchor-scroll" />
      <div data-testid="document-scroll" />
      {open && (
        <div ref={surfaceRef} data-testid="surface" style={position}>
          <div data-testid="surface-scroll" />
        </div>
      )}
      {open && nested && <div className="nested-choice" data-testid="nested-scroll" />}
    </>
  );
}

describe("a contextual anchored surface", () => {
  it("stays open for its own scrolling and dismisses on external scrolling", () => {
    render(<ContextualSurface />);

    fireEvent.scroll(screen.getByTestId("anchor-scroll"));
    expect(screen.getByTestId("surface")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("surface-scroll"));
    expect(screen.getByTestId("surface")).toBeInTheDocument();

    fireEvent.scroll(screen.getByTestId("document-scroll"));
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });

  it("treats a nested portaled choice as part of the surface", () => {
    render(<ContextualSurface nested />);

    fireEvent.scroll(screen.getByTestId("nested-scroll"));
    expect(screen.getByTestId("surface")).toBeInTheDocument();
  });
});
