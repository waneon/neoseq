# Neoseq Design Architecture

## Purpose and Boundary

Neoseq is a local-first outliner. Its interface keeps the reader's writing in
front and makes the graph's structure reachable without competing with it:
pages, journal days, and tags are places; blocks form an outline; properties
turn writing into records; queries answer questions about them.

This document is the repository-wide source of truth for design architecture.
Focused areas live under [`designs/`](designs/). Exact tokens and component
styling live in [`apps/client/src/ui/styles/`](apps/client/src/ui/styles/),
composed by [`app.css`](apps/client/src/ui/app.css).

The boundary is the browser client in light and dark modes, desktop and touch
layouts, keyboard and pointer input, and supported locales. The separate
server-administration app shares the semantic foundation and accessibility
baseline but not the writing surface.

## Principles

- **The writing is the subject.** Authored content owns the largest type and
  the reading measure; chrome is a step smaller and quieter.
- **Every visible element earns its place.** It shows state, names the current
  place, or offers a likely next action. Nothing restates what is already on
  screen: no label that repeats a title, no caption that repeats its heading, no
  hint that repeats its control.
- **Copy names and states.** Labels are nouns and verbs; descriptions explain
  non-obvious consequences. Encouragement and marketing sentences are excluded.
- **Quiet at rest, present at the hand.** Secondary verbs appear on hover and
  focus beside their object and remain reachable through menus, the command
  layer, and touch routes. A surface's primary verb is permanent.
- **Healthy is silent.** Saving, syncing, and loading appear only past a flash
  threshold or when something needs attention.
- **Stable geometry.** Content under the pointer or caret never moves because of
  focus, hover, selection, or arriving data. A control changes only its own
  region: state never changes type metrics, marks and counts grow into free
  space or ride a corner, and scroll gutters are reserved.
- **One system in both modes.** Roles are semantic and complete in light and dark;
  reader-chosen color is limited to choices whose contrast is guaranteed.
- **Accessibility and localization are constraints**, not polish.

## Experience Model

- The **visual foundation** supplies semantic color, type, depth, shape, and
  motion. See [Visual Foundation](designs/foundations.md).
- The **shell** places the reader: one rail for places, one top bar for the
  current document's controls, one scrolling document. See
  [Shell and Navigation](designs/shell-and-navigation.md).
- The **outliner** owns writing and structure. See [Outliner](designs/outliner.md).
- **Metadata and queries** enrich writing while staying subordinate to it. See
  [Metadata](designs/metadata.md) and [Query](designs/query.md).
- The **interaction language** gives controls, overlays, manipulation, and
  feedback one behavior. See [Interaction](designs/interaction.md) and
  [Accessibility](designs/accessibility.md).

## Spatial Architecture

The rail holds the graph switcher, Search and New page, the three place
directories (Journal, Pages, Tags), Favourites, and Recent, with Settings at its
foot. The top bar holds browser Back and Forward, the document's name once its
header scrolls away, exceptional status, the document's own controls, and Undo
and Redo. A document begins with its title; nothing sits above it.

Page material owns the page edge; outline text owns an inset edge whose margin
holds bullets and branches. The region below the last block remains a writing
target; answers and references follow it, and a journal continues into its
earlier days.

Phones replace the rail with a bottom bar (Journal, Search, New page, Library)
and a library drawer; while writing, an accessory with structural actions and
Done replaces it.

## Interaction Architecture

- Every capability has one canonical command and at least one pointer route;
  touch and keyboard routes are first-class where they apply.
- One state uses one primary signal. Focus, selection, current location, and
  keyboard roving use distinct indicators.
- A manipulation shows where its result lands and preserves layout until commit.
- An overlay belongs to the layer that summoned it, stays anchored, and yields
  Escape to the topmost open layer.
- Failures are plain, actionable, and owned by exactly one surface.

## State Ownership

- Graph-shared state describes the graph or its objects: tags, favourites and
  their order, property values, queries and saved views.
- Browser-local durable state describes one reader's use: theme, accent, rail
  collapse, recent visits, folded answers.
- Session state describes the current act: caret, selection, open layers,
  drafts, scroll position.
- Derived state such as results and counts is presented, never styled as
  authored data.

Moving a preference across these boundaries is a product decision, not a visual
one.

## Implementation Boundary

`apps/client` implements the writing product with React, Tailwind CSS, and
React Aria primitives. Primitives may supply focus management, selection
models, or positioning; they never supply Neoseq's appearance or override its
interaction contracts. `app.css` owns tokens and shared mechanisms; feature
sheets own only their composition.

`apps/dashboard` is a separately built application. It shares no client state
or component implementation; the semantic foundation, accessibility intent, and
identity assets cross the boundary.

## Evolution Rules

- Begin with the existing roles and interaction language; add a role only when a
  meaning cannot be expressed.
- Record intent and boundaries here and in `designs/`; keep measurements beside
  the implementation.
- A component change updates its focused document; a change to the shared
  model updates this file too.
- Verify both modes, responsive states, keyboard and pointer paths, locales,
  and reduced motion in proportion to the change.
- When design and implementation disagree, restore the invariant or change the
  architecture explicitly.
