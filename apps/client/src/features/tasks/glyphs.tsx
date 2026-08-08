// Status and priority carried by shape, never by colour.
//
// DESIGN.md allows exactly one chroma in the interface, so a status set cannot
// borrow the traffic-light palette other outliners use. Each state is instead a
// distinct mark inside the same 20px circle language — empty, half-filled,
// checked, crossed — and priority is a count of filled bars. Every glyph is
// monochrome `currentColor`, drawn at the outline icon stroke, and always sits
// beside (or inside the accessible name of) a text label; the shape is a faster
// read, never the only one.

import type { SVGProps } from "react";

const BASE: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 20 20",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function TaskStatusGlyph({ status, ...props }: { status: string } & SVGProps<SVGSVGElement>) {
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
          <path d="M10 3.8 A6.2 6.2 0 0 1 10 16.2 Z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "done":
      return (
        <svg {...BASE} {...props} data-status-glyph="done">
          <circle cx="10" cy="10" r="7" />
          <path d="m6.8 10.4 2.2 2.2 4.2-4.9" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...BASE} {...props} data-status-glyph="cancelled">
          <circle cx="10" cy="10" r="7" />
          <path d="m7.4 7.4 5.2 5.2 M12.6 7.4l-5.2 5.2" />
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

export function PriorityGlyph({ priority, ...props }: { priority: string } & SVGProps<SVGSVGElement>) {
  const level = ["low", "medium", "high"].indexOf(priority) + 1;
  const bars = [
    { x: 4.1, y: 11, h: 5 },
    { x: 8.7, y: 8, h: 8 },
    { x: 13.3, y: 5, h: 11 },
  ];
  return (
    <svg {...BASE} {...props} strokeWidth={0} data-priority-glyph={priority}>
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="2.6"
          height={bar.h}
          rx="1.3"
          fill="currentColor"
          opacity={level === 0 || index < level ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
