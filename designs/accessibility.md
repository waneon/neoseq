# Accessibility Design Architecture

## Boundary

Accessibility is a cross-cutting design contract for perception, semantics,
focus, keyboard and touch input, announcements, localization, and verification.
It constrains the visual foundation and every component architecture. A feature
is incomplete when its accessible route has different capability or meaning
from its pointer route.

## Perception

- Text and essential marks meet their role-specific contrast thresholds in both
  modes and across every selectable accent hue.
- State is never communicated by color alone. Shape, position, label, or
  programmatic semantics carries the same distinction.
- Focus is component-owned and clearly visible without changing the component's
  silhouette or layout.
- Motion respects reduced-motion preferences, while time-based information
  remains understandable.
- Truncated names expose their complete value through an accessible and
  pointer-readable route.

## Structure and Semantics

Application landmarks, skip navigation, and heading levels reflect the visible
structure. Styling does not turn generic text into a substitute for headings,
buttons, links, or list relationships.

The outline exposes a multi-selectable tree with expansion state and active-row
semantics. The editor remains the row's single tab stop, while bullets and
collapse actions stay keyboard-reachable through explicit navigation. Menus,
listboxes, tabs, and dialogs use their native interaction patterns rather than a
visual imitation.

Interactive elements are siblings when they represent separate actions. A row
may look like one object without nesting buttons inside links or controls inside
controls.

## Input and Focus

Every capability has a keyboard route and a pointer route; touch routes are
explicit wherever hover or context click would otherwise be required. Repeated
small controls meet the product hit-target floor, and targets grow on compact
touch layouts even when their visible marks do not.

IME composition is checked before command handling so text input does not lose a
keystroke. Escape may bypass composition only to perform its established
dismissal role.

Focus follows stable object identity through virtualization and authoritative
refresh. Opening a layer moves focus according to its pattern; closing restores
the invoking control or editing caret. The topmost layer owns dismissal and
announcement priority.

## Status and Announcements

Live regions match urgency: routine progress is quiet or polite; actionable
failure is assertive only when delay would be harmful. Visual text and announced
text describe the same state. A failure is announced by one owner, not repeated
by inline state and a toast.

Disabled actions remain discoverable when their absence would be confusing and
include a reason. Read-only and tombstone states are expressed in text and
semantics rather than relying on dimming or strike-through alone.

## Localization

One typed catalog owns product language. Document language and direction are set
before paint; user-authored text determines its own direction. Layout uses
logical relationships so RTL does not become a component-by-component mirror.

Components support expanded translations and RTL pseudo-locales without hiding
primary actions, clipping names, or reversing semantic sequences such as dates
and shortcuts. Typography may adapt tracking for a script but retains the shared
role hierarchy.

See [`../architectures/i18n.md`](../architectures/i18n.md) for runtime ownership
and catalog architecture.

## Verification

Automated accessibility checks cover representative light, dark, desktop, and
mobile states. Component tests cover keyboard movement, selection, focus return,
IME guards, and announcements. Geometry tests protect hit areas and non-shifting
focus affordances.

Automation is a floor. New interaction patterns also require keyboard-only,
screen-reader-semantic, zoomed, reduced-motion, localization-expansion, and touch
reasoning at the design boundary they affect.
