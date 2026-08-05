// A keyboard hint.
//
// Rendered as one element per key rather than as one string, because a modifier
// and the key it modifies do not line up when they are set as a single run of
// text: `⌘` and `K` come from different parts of a system face, at different cap
// heights, and with nothing between them `⌘K` reads as one four-stroke glyph.
// The layout rules live in `app.css` § .kbd; this component's only job is to
// hand it the parts.
//
// `parts` is a display sequence — modifier glyphs or words, any `+` separators,
// and finally the key — so `textContent` still reads exactly as the string form
// of the binding does. An accessible name and a rendered badge can never
// disagree about what to press.

import { cn } from "@/lib/utils";

export function Kbd({
  parts,
  /** Drops the filled chip: for a menu row or a table cell, where the badge is
   *  beside language rather than standing in for a control. */
  plain = false,
  className,
}: {
  parts: readonly string[];
  plain?: boolean;
  className?: string;
}) {
  return (
    <kbd className={cn("kbd", plain && "kbd-plain", className)}>
      {parts.map((part, index) => (
        <span
          key={`${part}-${index}`}
          className="kbd-part"
          data-separator={part === "+" || undefined}
        >
          {part}
        </span>
      ))}
    </kbd>
  );
}
