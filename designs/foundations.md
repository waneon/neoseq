# Visual Foundation Architecture

## Boundary

The visual foundation gives every product surface one semantic language for
color, typography, spacing, depth, shape, iconography, and motion. It defines
roles and invariants rather than component recipes. Exact values live in
[`../apps/client/src/ui/app.css`](../apps/client/src/ui/app.css).

Feature components consume foundation roles. They may compose those roles, but
they do not introduce private color systems, type scales, elevation languages,
or animation vocabularies.

## Semantic Color

The palette has three independent responsibilities:

- Neutral canvas, surface, rail, overlay, and ink roles establish hierarchy.
- The accent identifies action, reference, focus, selection, and current place.
- Semantic tones identify information, success, caution, attention, and danger.

These responsibilities do not cross. The accent is not a generic decoration or
status color; a status tone does not mark navigation or focus. Categories are
distinguished by name, mark, or position rather than arbitrary chroma.

The accent has a strong form for marks and a quieter form for references inside
prose. A reader may choose any hue, while lightness and chroma remain
system-owned so every point on the hue circle satisfies the same contrast
contract. Common hues remain direct choices; continuous adjustment is an
explicit secondary action. Tags reuse this safe hue family; they do not create
another structural palette.

State palettes store semantic tone names rather than raw colors. Due-date
preferences may instead store a bounded OKLCH hue and chroma pair when the reader
chooses a custom color. Both representations resolve through the same CSS tone
contract: lightness remains system-owned per mode, and raw RGB/hex colors never
enter persisted settings. Tone-derived styling is scoped to the object carrying
the state, and a tone may color its mark or compact value but not an entire row,
panel, or body of text.

## Modes and Contrast

Light and dark modes are two realizations of the same roles. Every token exists
in both modes, and mode resolution occurs before the application paints. Feature
logic never chooses a mode-specific color.

Contrast is a property of role pairs, not isolated swatches. Text roles declare
which grounds they may occupy; tinted grounds use a dedicated foreground role;
attention colors that meet only the non-text threshold remain glyph-only. The
entire selectable hue set is verified against canvas, filled actions, tints, and
both modes.

Color is never the sole carrier of state. Shape, label, position, or accessible
semantics must express the same distinction without color.

## Typography

The user's writing is the typographic top. Block content owns the body voice and
page titles own the largest display role; application chrome remains smaller and
quieter. The closed type scale prevents local components from manufacturing
hierarchy through ad hoc size or weight.

Weight rests at normal. Medium weight identifies emphasis or current choice, and
strong weight is reserved for headings. Monospace is for machine identifiers and
source-like values, never ordinary labels or prose. Numbers in controls, cells,
badges, and times use stable figures so changing values do not move adjacent
layout.

Markdown headings fit between page title and body text. They do not draw full-row
rules inside an outline, where a rule would imply a page boundary. Group labels
and table column labels are separate roles because they describe different kinds
of structure.

The primary family supports Korean and Latin with one voice. Locale adaptations
may relax tracking, but they do not create a parallel scale.

## Geometry, Depth, and Shape

Spacing and radii are closed vocabularies. Radius grows with surface scale: keys
and controls are tighter than panels and dialogs. Hit areas may exceed visible
geometry, especially for repeated small controls such as bullets and marks.

Depth combines:

1. a luminance change that establishes a ground;
2. a hairline that closes a bounded or interactive object; and
3. a cast that communicates distance from the page.

Fields and field substitutes are inset. Buttons, cards, chips, and selected keys
are raised. Menus and dialogs add increasing distance. A hover fill alone never
defines a resting control, and adjacent regions are not separated by a line
without a ground change.

Whole-pixel geometry protects icon and rule clarity. Icon boxes use compatible
dimensions, sibling rows that claim shared columns use shared tracks, and one
global scrollbar language serves every scrolling surface.

## Motion

Motion explains entry, disclosure, size change, or off-canvas travel. A new
floating layer may combine a short rise with an early-completing fade. Content
already on screen does not translate under a pointer, and closing overlays leave
immediately instead of asking the reader to wait for an exit animation.

Surfaces that must be read in the frame they appear, such as unsolicited
feedback, do not animate opacity. Hover disclosure is immediate. Reduced-motion
mode collapses decorative durations while preserving time-based information such
as a progress countdown.

The motion vocabulary is shared. Components select an existing transition role;
they do not invent local easing or duration systems.

## Ownership and Verification

`app.css` owns semantic tokens and global visual mechanisms. The shadcn mapping
adapts those tokens to primitives, and feature styles compose them. Primitive
defaults cannot introduce a second focus ring, shadow language, or palette.

Foundation changes are verified across both modes, the supported hue set,
responsive layouts, and reduced motion. Contrast tests cover role pairs rather
than only the default theme.
