---
version: 3
name: Neoseq Design System
description: The design language for Neoseq, a local-first outliner. Structure is the ornament — the indent thread that carries an outline's meaning is also the graphic signature of the interface. Luminance separates surfaces instead of borders, Pretendard carries the type, one ink-indigo accent carries every action, and both modes ship from a single token declaration. Chrome is small, named, and permanent; everything else is summoned by ⌘K.

# Tokens are the contract, declared once per mode in `apps/client/src/ui/app.css`
# (the implementation of record). Hue and chroma are constant across modes.

colors:                                # "light / dark" — warm neutrals (hue 75/78), never blue-grey slate
  canvas:       "oklch(1 0 0) / oklch(0.175 0.004 78)"             # the writing surface
  surface-1:    "oklch(0.985 0.003 75) / oklch(0.205 0.005 78)"    # inset panels
  surface-2:    "oklch(0.955 0.004 75) / oklch(0.250 0.005 78)"    # the one hover colour; chips, badges
  surface-3:    "oklch(0.930 0.005 75) / oklch(0.290 0.006 78)"    # active / pressed
  rail:         "oklch(0.968 0.004 75) / oklch(0.145 0.004 78)"    # navigation rail
  overlay:      "oklch(1 0 0) / oklch(0.215 0.005 78)"             # menus, dialogs, palette
  ink:          "oklch(0.255 0.009 75) / oklch(0.930 0.004 85)"    # body text, the user's words
  ink-2:        "oklch(0.450 0.008 75) / oklch(0.740 0.006 80)"    # secondary text
  ink-3:        "oklch(0.530 0.008 75) / oklch(0.625 0.006 80)"    # metadata, placeholders, resting glyphs
  accent:       "oklch(0.500 0.160 268) / oklch(0.760 0.130 268)"  # ink indigo — the only structural chroma
  accent-hover: "oklch(0.440 0.160 268) / oklch(0.810 0.110 268)"
  on-accent:    "oklch(1 0 0) / oklch(0.155 0.004 78)"
  danger:       "oklch(0.495 0.140 35) / oklch(0.715 0.130 35)"
  ok:           "oklch(0.500 0.120 150) / oklch(0.760 0.130 150)"
  attention:    "oklch(0.545 0.130 75) / oklch(0.795 0.125 78)"    # the neutral hue at chroma; glyphs only
  scrim:        "oklch(0.255 0.009 75 / 0.28) / oklch(0 0 0 / 0.55)"
  derived:                             # declared once — ink- or tone-relative
    line: "10% ink"                    # the only legal 1px lines — see Depth & Shape
    line-strong: "16% ink"             # inset ring on overlays floating over content
    thread: "8% ink"                   # hairline seams inside panels and tables
    thread-line: "30% tone"            # the outline's indent guide, reader-toned; 72% on the lit path
    halo: "9% ink"                     # ring behind a collapsed bullet
    accent-soft: "10% accent / 18% dark"   # the selection ribbon
    danger-soft: "10% danger / 16% dark"
    scroll-thumb: "20% ink · 34% under the pointer"
  state:                               # aliases only — see The state palette
    status: "todo currentColor · doing {attention} · done {ok} · cancelled {danger}"
    priority: "low {ink-3} · medium {attention} · high {danger}"

typography:
  family-sans: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Helvetica Neue", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif'
  family-mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
  # Five sizes. Nothing else exists. Weight never exceeds 600.
  xs:  { size: 12px, line: 16px, track: 0em,      weight: 550 }  # metadata, chips, badges
  sm:  { size: 14px, line: 20px, track: -0.005em, weight: 500 }  # UI default
  md:  { size: 16px, line: 26px, track: 0em,      weight: 500 }  # block text, page body
  lg:  { size: 19px, line: 25px, track: -0.012em, weight: 600 }  # section headings (<h2>)
  xl:  { size: 33px, line: 40px, track: -0.019em, weight: 600 }  # page/journal titles (<h1>)
  mono-xs: { size: 12px, line: 16px, weight: 550 }               # identifiers only
  group-label: { size: 12px, track: +0.06em, weight: 600, color: "{ink-3}" }  # every list divider
  markdown-headings: "# 28/36 · ## 24/32 · ### 20/28 · #### 16/26 · deeper repeats 16/26 in {ink-2}"

spacing: "sp-0…sp-8 = 2 4 8 12 16 24 32 48 64"

metrics: "measure 848px (~87ch) · gutter 24 (16 ≤600px) · rail 240 · topbar 44 ·
  control-row 32 · outline-row 28 · indent 30 · bullet-slot 20 ·
  hit-target 24 (32 ≤600px) · append min(40vh, 320px)"

radius: "r-1 4px chips · r-2 6px controls · r-3 10px panels · r-4 14px dialogs · r-full the bullet dot only"

elevation: "e1 inset 1px {line} — ringed controls (chips: 1.5px {line-strong}) ·
  e2 ring + soft cast — floating · e3 ring + deep cast — modal"

motion:
  durations: "press 90 · view 120 · overlay 140 · disclose 180 · size 220 (ms)"
  entrance-property: opacity     # transform is never animated — see Motion
  exceptions: "a box's own size (height, grid-template-columns) · the collapse chevron's rotation"
  reveal: "0ms — hover-revealed chrome is instant · reduced-motion honoured"

layers: "content 0 · scrim 25 · drawer 30 · dialog 50 · popover 55 · menu 60 · palette 65 · toast 70"

iconography: { library: lucide, size: "14px — 16px in rail and palette", strokeWidth: 2, rest: "{ink-3}", hover: "{ink}" }
---

## Overview

Neoseq is a local-first outliner. Its subject is structure — a thought indented under
another thought, a day that holds what happened in it, a tag that turns a line into a
record — and the interface is built from that material.

- **The thread is the signature.** The line from a parent bullet down past its children
  is drawn explicitly, in a tone the reader chooses, lighting the path to the caret.
- **Everything around it is quiet.** Surfaces separate by a 3–5% lightness step, never a
  border; one accent carries every action; colour names states, never categories.
- **Two complete modes from one declaration** — hue and chroma fixed, only lightness moves.
- **Chrome is small, named, and permanent** (§ Disclosure); every other verb lives in the
  `⌘K` palette, which is what licenses the bareness and therefore never regresses.
- **The user's writing is the typographic top** — chrome is 14px or smaller.

## Principles

1. **Structure is the ornament.** A device that encodes nothing true does not ship.
2. **Luminance separates; lines do not.** Every border outside § Depth & Shape is a bug.
3. **No token without both modes.** Alpha-on-canvas ink is banned — it cannot invert.
4. **One signal per state** — a fill *or* a rule *or* a weight. Colour is the one
   required second: a tint is legal only where a shape or word already says the same thing.
5. **Every capability has one command and one pointer route** — enforced by a test.
6. **Nothing is hidden until it can be found**: a hover-gated control is also in the
   palette, pinned on touch, and revealed on focus.
7. **Silent when steady, plain when not** — saved, online, and on-today render nothing;
   deviations are unbordered text, never a `title` attribute alone.
8. **Nothing below the outline is chrome** — the region under the last block is a live
   append target; no form may be mounted there.

## Color

**Modes are CSS-only.** `prefers-color-scheme` applies to `:root:not([data-theme="light"])`;
an explicit `data-theme` wins both ways; a pre-paint script applies the stored choice.
JavaScript never decides a colour; `color-scheme: light dark` keeps native controls on theme.

**Roles.** `canvas` is the writing surface; `surface-1/2/3` step inward for panels,
hover, and pressed; `overlay` is anything floating; the three inks are the text
strengths. `accent` is reserved for actions, links, carets, selection and drop, and the
lit thread — there is no second structural colour, ever. `danger`, `ok`, `attention` name
states; categories are distinguished by shape, position, or label.

**The state palette.** Task status and priority earn tones because they are closed,
ordered enumerations — one tone per step, aliased from the tokens above. Five rules: the
shape says it first (every tinted mark is legible in greyscale); the unstarted step
declines a tone; a tone may fill its own mark and tint its own chip, never a row, band,
panel, or body-size text; a settled state inverts (`done`/`cancelled` fill their disc and
cut the mark out in `--on-tone` — the one two-colour glyph); a key's mark is untinted.

**The tone map.** A colour preference (the thread's tone, date-urgency tints) stores the
*name* of a declared step — `neutral | accent | ok | attention | danger` — carried as
`data-palette` and resolved to `--tone` in CSS. A preference can never leave the palette
and tints exactly one surface: tone-derived tokens are declared on the element carrying
`data-palette`, never on `:root`.

**Contrast rules** (verified in CI, both modes): `--ink-3` is legal on `canvas`,
`surface-1`, `rail`, and `overlay` only — 12–14px text on `surface-2/3` uses `--ink-2`.
`--attention` is a glyph tone, held to the 3:1 non-text bar, never used for text. A tone
behind small text is pulled 30% toward ink (`color-mix`) so every tinted chip clears AA.

## Typography

Self-hosted Pretendard Variable, first in the stack so Korean and Latin share one voice,
precached with the app shell. Tracking is in `em`, zero for body, negative only in UI
labels and at 19px+; locale overrides may zero it but never add a sixth size.

- **Five roles are the whole scale.** Block text (`md`, 16/26) is the only 26px
  line-height and the largest 500-weight text — chrome and content are different kinds.
- **Markdown headings** get four steps, anchored under the 33px page title and on the
  body size; `#####` and deeper repeat the body size in `--ink-2`.
- **The mono voice** is for identifiers only — property keys, graph ids, ISO dates,
  SPARQL — never labels or prose. Shortcut badges are sans, one element per key.
- **The group label** divides every grouped list, differing from its rows in four ways at
  once: 12px vs 14px, 600 vs 500, +0.06em (the only positive tracking), `--ink-3`.

## Layout

The shell is a two-column grid — 240px rail, `1fr` content — at `100dvh`. The rail
collapses on `⌘\` above 840px and becomes an off-canvas drawer (inert when closed) below.

- **Exactly one region scrolls**: the content container. The shell never scrolls; the top
  bar is a fixed 44px and never reflows.
- **The measure is 848px** (~87ch) — wider than the prose ideal because each outline
  level spends one indent of it, and bullets are thoughts, not paragraphs.
- **Breakpoints**: ≤840px drawer · ≤700px settings nav stacks · ≤600px gutter 16px and
  every hover-revealed control pins visible at 32px. On touch nothing is hover-gated;
  long-press raises the same context menus as right-click.

## Depth & Shape

Depth is lightness — a 3–5% step for flat surfaces, `--e1` for ringed controls, `--e2`
floating, `--e3` modal — not shadow and not outline.

**Legal 1px lines** — in chrome: the rail's edge (light mode only), the palette's
input/results divider, `--line-strong` as an overlay's inset ring. In the writing: a
thematic break, and a rule under `#`/`##`. In a panel: the seam between two halves of one
field. Every other border is deleted — no bordered cards, pills, or dashed empty states.

**Radius grows with the surface**, so a control is always tighter than its panel, and
focus never adds a second silhouette. **One scrollbar**, declared once globally — thin,
trackless, ink-relative; no component declares another, components only reserve gutter.

## Motion

Motion explains a change; it never decorates one, and it never moves anything.

1. **Every entrance is opacity.** `transform`/`scale`/`translate` never animate. Named
   exceptions: the off-canvas drawer (it starts outside the viewport), a box's own size
   (content never moves relative to its box), the collapse chevron's rotation.
2. **Overlays animate in, never out.** A closing surface unmounts immediately.
3. **Surfaces read on arrival do not animate** — page bodies, dialog panels, settings,
   toasts mount at full alpha; the scrim fades, the panel does not. `--dur-view` is only
   for content replacing content inside a box already on screen.
4. **Hover-revealed chrome is instant.**
5. **Reduced motion collapses durations to 1ms.** The one exemption is the toast
   countdown bar, which is information, not motion.

## Interaction States

Every control defines all five states. **Hover** is `--surface-2` — the one hover colour
— with glyphs rising to `--ink`. **Focus** is component-owned: luminance plus the resting
edge for fields, the caret and thread for writing surfaces, the existing glyph or
selection elsewhere; native outlines are suppressed and there is no global ring.
**Pressed** is `--surface-3` (primary action: `--accent-hover`), never a transform.
**Disabled** is 50% opacity, still in layout, announced, and listed in the palette *with
its reason*. Hover and keyboard focus share one highlight (`--surface-2` wash + a 2px
accent rule at the left edge) in every menu, option list, and the palette; `↑↓` move it,
`⏎` chooses, `⎋` leaves; a chosen value says so with a check, never a second wash.

## Disclosure

**If a control is not on the always-visible list, it may not be permanently visible.**
The list: wordmark, graph switcher, `Search ⌘K`, `Journal`, `Tags`, page list + `＋`,
`Settings`, the save/sync/live slots (nothing when steady), the read-only label, every
bullet, the `Today` pill (off-today only), a toast's `×`, and one `⋯` in the top bar
generated from the command registry. The top bar holds no named verbs.

Everything else is **revealed** on hover/focus/`[data-focused]` — always with `opacity`,
never `display`, always also in the palette and pinned on touch; **summoned** — the
palette, settings, pickers, dialogs, and context menus, which hang on the object they act
on (the bullet, the title row), never on a parked button; or **raised** — toasts only:
the one surface the user did not ask for, hence the one always-visible dismiss.

## The Command Layer

The palette pays for the bare interface, so it ships before anything is hover-gated.

- **One registry, one listener.** Every command declares `id, group, label, binding?,
  scope, when?, disabledReason?, run` — and a mandatory `pointerRoute`, failed by a unit
  test when omitted: the palette may never be the only route.
- **Key arbitration**: the IME guard first (CJK input never loses a keystroke; only
  `Escape` bypasses it), then open overlay → editor scope → global scope. Global bindings
  must carry `⌘`/`⌃`, so no bare key is stolen from a text field.
- **Defaults**: `⌘K` palette · `⌘P` properties · `⌘/` shortcuts · `⌘\` rail · `⌘,`
  settings · `⌘Z`/`⇧⌘Z` undo/redo. All rebindable from one resolved table (fed to the
  listener, the sheet, and every badge); rebinding refuses duplicates, browser-owned
  keys, and text-field keys. The outline's writing keys are not commands and cannot be rebound.
- **The palette**: navigation ranks first; never blank; dates parse in the same input
  (`tomorrow`, `aug 5`, `다음 월요일`); the last row is always a way forward; disabled
  commands are listed with their reasons; closing restores the caret exactly.

## Component Rules

Architecture-level invariants. Pixel specs live in `app.css` beside the tokens.

- **Outline.** The bullet is the block's handle (click focuses, drag moves, right-click
  menus) and a real `<button>`; the textarea is the row's single tab stop. The thread is
  drawn as virtualized row backgrounds; a collapsed row's halo replaces it. No row fill —
  the caret is the signal; an empty line is a 40% bullet; the append zone is the new-line
  affordance, and a press begun over an open overlay only dismisses.
- **Markdown.** A projection of the block, not a second block: a press opens the source
  at the pressed word, the projection carries the row's tab stop, links follow instead of
  editing. No imported prose theme or bordered callout; raw HTML and images never render.
- **Selection.** Caret and block selection never coexist. Row-range based, one continuous
  `--accent-soft` ribbon; a selected descendant is a passenger; bulk verbs are one undo
  step resolved against the visible outline; copy is portable Markdown.
- **Properties.** Metadata, not a form: quiet rows and chips, nothing when empty. One
  contextual picker is the only writing surface (`/`, `⌘P`, context menus, palette rows);
  dates parse words with the native picker as the precision tool; system keys are page info.
- **Tasks.** Any block with `builtin.task-*` keys — no separate storage or generic rows.
  Status and priority are shape-first glyphs before the text; done and cancelled strike
  the line. A moment is a day plus an optional time; a missed one says `Overdue` in
  words; urgency thresholds and tones are the reader's, the step order is not.
- **Query block.** The answer is the block; the question is a disclosure: at rest, one
  caption phrase (the control that opens the editor) and a count that is also the empty
  state. The builder reads as a sentence in rows — controls read as words, one left edge,
  groups are depth not cards; hand-written SPARQL is its own entrance, never a conversion.
  Results render in full; column order, width, visibility, and sort are the saved view data.
- **Status slots.** Save, sync, live share one language: nothing when steady, a 5px dot
  after 600ms while working, a `--danger` dot with a plain-text reason on failure — each
  failure reported by exactly one surface.
- **Toasts.** For failures with no home on screen: tone as a 16px glyph (never colour
  alone), a countdown bar that pauses honestly, repeats collapse, no entrance animation.
  An action on a toast is always a second route.
- **Settings.** A dialog, not a route (`?settings=…`; Back closes it); two labelled
  scopes — browser-wide and this-graph. Every appearance choice previews itself at the
  size it will render.
- **Choice.** Every list of choices opens the same menu the bullet opens — never a native
  `<select>` or `<datalist>`. Native stays where the platform is better: checkboxes,
  date and time inputs.
- **Overlays.** All portaled, on one `--z-` scale, dismissed by outside click, `⎋`, and
  selection. Anchored panels share one placement function: below the anchor, flipped
  above when the room is above, `max-height` the room actually left.
- **System states.** Under the ~220ms flash threshold show nothing; an empty state is the
  action itself; failure keeps the shell (tombstones render in the page body); read-only
  explains itself in the palette; a rejected command is never silent and never reported
  twice, and error text names the verb, not a code.

## Accessibility Contract

Non-negotiable; enforced by CI (axe, wcag2a/aa, serious + critical, both modes).

1. Contrast follows § Color's rules; `--ink-3` and `--attention` respect their bounds.
2. Focus appearance is component-owned; no native or global outlines.
3. Real landmarks (`<main>`, a skip link) and real headings — no uppercase spans.
4. State is never colour-only and never `title`-only.
5. The tree exposes `aria-expanded` and `aria-activedescendant`; the textarea is the
   single tab stop; every collapse affordance is keyboard-reachable.
6. Live regions match urgency: off / status / assertive / alert.
7. Hit targets ≥ 24px, ≥ 32px at or below 600px.
8. IME composition is guarded before any key handler; `Escape` alone bypasses the guard.
9. Localization: one typed catalog, `lang`/`dir` set pre-paint, logical properties,
   `dir="auto"` for user text; components survive the 2× expansion and RTL
   pseudo-locales. See `architectures/i18n.md`.

## Implementation

Tailwind CSS v4 + shadcn/ui over Radix, layered over these tokens.

- Cascade is explicit: `@layer theme, base, neoseq, components, utilities`, with
  `app.css` imported into `neoseq` so utilities can override bespoke classes.
- One owner per token: `app.css` owns colour, type, radius, and motion; `globals.css`
  only maps them onto shadcn's variables via `@theme inline`.
- One place per global: the scrollbar and the anchored-panel placement are each declared
  once; reimplementing either is a bug.
- Radix supplies behaviour; this document supplies appearance. shadcn focus rings are removed.
- Bespoke class names contain a hyphen, never a bare utility name. `spellcheck="false"`
  at the root — the browser has no dictionary for a graph.

## Do / Don't

**Do**: light the thread to the caret · separate by lightness · declare both modes
together · reserve the accent for actions · render nothing when steady · give every verb
a key, a palette row, and a pointer route · reveal with opacity, instantly · hang menus
on the object they act on · store colour preferences as tone names · keep chrome ≤ 14px.

**Don't**: draw borders between surfaces · tint categories or chrome glyphs · let a tone
fill more than its own mark and chip · put `--ink-3` on `surface-2/3` · animate transform
· add focus rings · ship two look-alike controls that open different popups · state a
fact twice on one screen · mount a form below the outline · hover-gate without palette,
touch, and focus routes · toast what the user can already see · declare a token in two files.
