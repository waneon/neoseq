// Status and priority carried by shape first, then by colour.
//
// Each state is a distinct mark inside the same 20px circle language — empty,
// half-filled, checked, crossed — and priority is a count of filled bars, so the
// set survives monochrome, greyscale printing and any form of colour blindness.
// Every glyph also sits beside (or inside the accessible name of) a text label.
//
// On top of that the state palette gives each step its own tone, keyed off the
// `data-status-glyph` / `data-priority-glyph` attribute in app.css. Colour is
// therefore the second reading of a state and never the first, which is what
// makes it safe: a reader who cannot tell amber from green still has the shape,
// the label, and the strike through a settled line. `data-plain` opts a glyph
// out of the tone for the one case that is not a value — the mark that stands
// beside a *key*'s name in the picker.
//
// The two *settled* states are drawn the other way round: the tone fills the
// disc and the mark is cut out of it in `--on-tone`. A finished task is the one
// state a person scans a page for, and an outlined tick at 16px was the quietest
// mark on the row rather than the loudest. The shape still carries it — a filled
// disc is as distinct from an empty ring as a ticked one was — so the inversion
// buys weight without spending the non-colour reading.

import type { SVGProps } from "react";

const BASE: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 20 20",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  // 2px, not 1.8: the ring is the only thing an unstarted task draws, and at
  // 16px the old hairline read as a smudge beside the bullet.
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function TaskStatusGlyph({
  status,
  ...props
}: { status: string } & SVGProps<SVGSVGElement>) {
  switch (status) {
    case "todo":
      return (
        <svg {...BASE} {...props} data-status-glyph="todo">
          <circle cx="10" cy="10" r="7" />
        </svg>
      );
    case "doing":
      return (
        <svg {...BASE} {...props} data-status-glyph="doing">
          <circle cx="10" cy="10" r="7" />
          <path d="M10 3.6 A6.4 6.4 0 0 1 10 16.4 Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "done":
      return (
        <svg {...BASE} {...props} data-status-glyph="done">
          <circle cx="10" cy="10" r="8" fill="currentColor" stroke="none" />
          {/* `glyph-mark` takes `--on-tone` in app.css: the mark is cut out of
              the filled disc, so it can never be drawn in the fill's own ink. */}
          <path className="glyph-mark" d="m6.3 10.3 2.5 2.5 4.9-5.8" strokeWidth={2.2} />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...BASE} {...props} data-status-glyph="cancelled">
          <circle cx="10" cy="10" r="8" fill="currentColor" stroke="none" />
          <path className="glyph-mark" d="m7 7 6 6 M13 7l-6 6" strokeWidth={2.2} />
        </svg>
      );
    default:
      // A stored value outside the suggested set is still a status: a dashed
      // ring says "set, but not one of the named shapes".
      return (
        <svg {...BASE} {...props} data-status-glyph="other">
          <circle cx="10" cy="10" r="7" strokeDasharray="2.4 2.8" />
        </svg>
      );
  }
}

// Three bars, sized to the same box the status ring fills. They used to be 3px
// wide across 63% of the glyph, which is why priority needed a tinted tile behind
// it to hold its own beside a status disc that fills 80% — the mark was small and
// the fix was a rectangle. At 4px across 75%, with the tallest bar reaching the
// ring's own top and bottom, the two marks read at one weight and the tile is
// gone (app.css § .task-priority-toggle).
export function PriorityGlyph({
  priority,
  ...props
}: { priority: string } & SVGProps<SVGSVGElement>) {
  const level = ["low", "medium", "high"].indexOf(priority) + 1;
  const bars = [
    { x: 2.5, y: 10 },
    { x: 8, y: 6 },
    { x: 13.5, y: 2.5 },
  ];
  return (
    <svg {...BASE} {...props} strokeWidth={0} data-priority-glyph={priority}>
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="4"
          height={17.5 - bar.y}
          rx="2"
          fill="currentColor"
          // The bars above the level are the same mark held back, not a second
          // colour: they are what makes "one of three" legible without a label.
          opacity={level === 0 || index < level ? 1 : 0.26}
        />
      ))}
    </svg>
  );
}
