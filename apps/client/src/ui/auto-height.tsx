// A box that animates to whatever height its content needs.
//
// The defect it exists for: a container whose body swaps between two lengths
// resizes in a single frame. In the diagnostic recorder, choosing `Enhanced`
// replaced a two-line ledger with a scope picker, a category list and a warning —
// the dialog grew ~200px instantly, which both re-centred the panel in the
// viewport and moved the `Start recording` button out from under a pointer that
// was already travelling toward it. That is exactly the moving target
// DESIGN.md § Motion rule 1 forbids, and animating the height is what prevents it
// rather than what causes it: the box grows to meet the content, and the content
// never moves relative to the box it is in.
//
// It measures rather than guesses, so it works with content whose own height is
// not knowable in advance (wrapped translations, a growing list). It is inert
// until the first measurement lands, so a server render or a layout-less test
// environment gets an ordinary auto-height div and no clipping.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AutoHeight({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = inner.current;
    // jsdom has no layout and no ResizeObserver: an unmeasured box is a plain
    // `height: auto` div, which is the correct fallback rather than a 0px one.
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn("auto-height", className)}
      data-measured={height === null ? undefined : "true"}
      style={height === null ? undefined : { height }}
    >
      <div className="auto-height-inner" ref={inner}>
        {children}
      </div>
    </div>
  );
}
