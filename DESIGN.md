---
version: 6
name: Neoseq Design System
description: The design language for Neoseq, a local-first outliner. Graphite and one accent — the writing sits on paper, everything that is not the writing is a cool neutral, and a single accent carries every action, the caret, the selection, a tag, and the branch through the outline. Surfaces separate by luminance and are closed by a hairline when they float; a control is raised or inset, never flat. Structure is still the ornament: the outline is drawn in one hue at two weights — quiet guides for the indents a row passes, one bold stroke for the path to the caret. The accent's hue is the reader's, its lightness is not, so both modes ship from a single token declaration and every choice keeps its contrast.

# Tokens are the contract, declared once per mode in `apps/client/src/ui/app.css`
# (the implementation of record). Every figure below is measured — see § Contrast.

colors:                                # "light / dark" — cool neutrals (hue 264), never beige
  canvas:       "oklch(1 0 0) #ffffff / oklch(0.207 0.007 264) #16181b"       # the writing surface
  surface-1:    "oklch(0.981 0.003 264) #f8f9fb / oklch(0.242 0.008 264) #1e2024"  # inset panels
  surface-2:    "oklch(0.958 0.005 264) #eff1f5 / oklch(0.278 0.009 264) #26282d"  # the one hover colour
  surface-3:    "oklch(0.931 0.007 264) #e6e8ed / oklch(0.318 0.011 264) #2f3238"  # active / pressed
  rail:         "oklch(0.974 0.004 264) #f5f6f9 / oklch(0.178 0.007 264) #101114"  # navigation rail
  overlay:      "oklch(1 0 0) #ffffff / oklch(0.253 0.009 264) #202227"       # menus, dialogs, palette
  raised:       "oklch(1 0 0) / oklch(0.3 0.01 264)"                          # a control lifted off a ground
  raised-hover: "oklch(0.981 0.003 264) / oklch(0.34 0.011 264)"
  ink:          "oklch(0.235 0.014 264) #1b1e25 / oklch(0.955 0.004 264) #eff0f3"  # the user's words
  ink-2:        "oklch(0.462 0.014 264) #555961 / oklch(0.762 0.011 264) #aeb2b9"  # secondary text
  ink-3:        "oklch(0.548 0.013 264) #6d7179 / oklch(0.632 0.013 264) #868a92"  # metadata, placeholders
  accent:       "oklch({accent-l} {accent-c} {accent-h}) — iris by default, the only chroma"
  accent-h:     "277 — the hue, and the one colour preference in the product (§ The accent is a hue)"
  accent-l:     "0.535 / 0.705 — never the reader's; this is what holds the contrast table"
  accent-c:     "0.208 / 0.185"
  accent-hover: "oklch(0.472 0.203 {accent-h}) / oklch(0.775 0.155 {accent-h})"
  accent-quiet: "oklch(0.5 0.115 {accent-h}) / oklch(0.755 0.095 {accent-h})"  # the accent in a sentence
  on-accent:    "oklch(1 0 0) / oklch(0.17 0.008 264)"
  danger:       "oklch(0.516 0.187 26) #bb2427 / oklch(0.712 0.155 26) #f4776e"
  ok:           "oklch(0.508 0.128 152) #10793e / oklch(0.762 0.13 152) #6cc988"
  attention:    "oklch(0.58 0.135 62) #b16400 / oklch(0.805 0.13 78) #edb454"  # glyph tone only
  info:         "oklch(0.535 0.17 255) / oklch(0.72 0.14 255)"  # the fourth state tone; never the accent
  scrim:        "32% ink / 62% near-black — plus a 3px backdrop blur"
  derived:                             # declared once — ink-, accent- or tone-relative
    line: "11.5% ink / 15% — closes a floating surface, separates a table's cells"
    line-strong: "19% ink / 24% — the ring on a control standing in for a field"
    thread: "8% ink / 11% — the hairline inside a panel"
    thread-line: "22% accent / 28% — the indent guides, 1px"
    thread-lit: "{accent} — the branch to the caret, 2px, opaque so it covers the guide it runs on"
    halo: "10% ink / 14% — the ring behind a collapsed bullet"
    accent-soft: "12% accent / 20% — the selection ribbon, the current nav row, a focus halo"
    accent-tint: "7% accent / 11% — the current settings pane, an inviting empty tile"
    on-tint: "the tone mixed 70/30 with ink — any label on a tinted fill"
    scroll-thumb: "22% ink · 38% under the pointer"
  state:                               # aliases only — see The state palette
    status: "todo currentColor · doing {attention} · done {ok} · cancelled {danger}"
    priority: "low {ink-3} · medium {attention} · high {danger}"
    tag: "{accent-quiet} — a reference is a link, spoken at the volume of a sentence"
    tones: "neutral {ink-2} · info · ok · attention · danger — the five a preference may name"

typography:
  family-sans: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Helvetica Neue", "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif'
  family-mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
  # Five sizes. Nothing else exists. Weight rests at 400 and never exceeds 600.
  xs:  { size: 12px, line: 16px, track: 0em,      weight: 400 }  # metadata, chips, badges
  sm:  { size: 14px, line: 20px, track: -0.006em, weight: 400 }  # UI default
  md:  { size: 16px, line: 26px, track: 0em,      weight: 400 }  # block text, page body
  lg:  { size: 18px, line: 26px, track: -0.014em, weight: 600 }  # section headings, dialog titles
  xl:  { size: 30px, line: 38px, track: -0.024em, weight: 600 }  # page/journal titles (<h1>)
  weights: "normal 400 · medium 500 · strong 600"
  mono-xs: { size: 12px, line: 16px }                            # identifiers only
  group-label: { size: 12px, track: +0.06em, weight: 600, color: "{ink-3}" }  # every list divider
  column-label: { size: 11px, track: +0.03em, weight: 600, color: "{ink-3}" } # a table's own headings
  markdown-headings: "# 25/34 · ## 21/30 · ### 18/27 · #### 16/26 · deeper repeats 16/26 in {ink-2}"

spacing: "sp-0…sp-8 = 2 4 8 12 16 24 32 48 64"

metrics: "measure 848px (~87ch) · gutter 24 (16 ≤600px) · rail 248 · topbar 48 ·
  text-inset 26 (slot + gap + padding — where the writing starts; the page's own
    material starts at the gutter, § Two edges) ·
  mark-slot 16 + mark-gap 9 (the rail's one glyph column) ·
  control-row 32 · chip 24 · outline-row 28 · indent 30 · bullet-slot 20 · bullet-disc 20 ·
  guide 1 · branch 2 · branch-turn 10 · tag-gap 12 ·
  settings-shell round(down, clamp(272, 100dvh − 128, 408), 1px) — one height,
    every section ·
  hit-target 24 (32 ≤600px, and the icon button grows with it) · append min(40vh, 320px)"

radius: "r-1 4px chips and key badges · r-2 7px controls · r-3 12px panels ·
  r-4 16px dialogs and the palette · r-full the bullet dot only"

elevation:                             # a control is raised or inset, never flat
  e1: "inset ring of {line} — a field, and anything standing in for one"
  e1-chip: "inset ring of 1.5px {line-strong} — a chip, which is too small for a hairline"
  e1-raised: "ring + a 1px lit top edge + a short contact cast — a button, a card;
    filled with {raised}, never {canvas}, which is the lightest surface in one mode
    and the darkest in the other"
  e2: "ring + soft cast — floating: menus, popovers, toasts"
  e3: "ring + deep cast — modal: dialogs, the palette"
  lit-edge: "inset 0 1px 0 white/16% (10% dark) — the top of any filled control"

motion:
  durations: "press 80 · view 120 · overlay 170 · disclose 200 · size 260 (ms)"
  easings: "out cubic-bezier(.32,.72,0,1) · entrance cubic-bezier(.16,1,.3,1) · size cubic-bezier(.2,0,0,1)"
  rise: 4px                            # how far a floating surface travels in
  entrance: "opacity + `rise` + 0.985 scale, opacity finishing by 40% — see Motion"
  opacity-free: "a surface read on the frame it mounts (a toast) moves only"
  reveal: "0ms — hover-revealed chrome is instant · reduced-motion honoured"

layers: "content 0 · scrim 25 · drawer 30 · dialog 50 · popover 55 · menu 60 · palette 65 · toast 70"

iconography: { library: lucide, size: "14px dense chrome · 16px a row someone reads
    (rail, palette, menus) — both even, and every box that centres one is even too,
    because an odd glyph in an even box lands on a half pixel", strokeWidth: 2,
  rest: "{ink-3}", hover: "{ink}", current: "{accent}" }
---

## Overview

Neoseq is a local-first outliner. Its subject is structure — a thought indented under
another thought, a day that holds what happened in it, a tag that turns a line into a
record — and the interface is built from that material.

- **The branch is the signature, and it is drawn where it says something.** The indents a
  row merely passes are quiet 1px guides. The path from the root to the caret is one
  continuous 2px stroke — down each ancestor's column, a turn, a run onto the next bullet,
  level after level. Columns alone say "these are indented"; a branch says "this one is
  mine", and drawn beside *every* bullet it says nothing at all.
- **Graphite and one accent.** Everything that is not the writing is a cool neutral that
  never competes with ink. One accent carries every action, the caret, the selection, the
  current place, a tag, and the branch. There is no second structural chroma — and the
  reader may move that accent's hue, never its lightness.
- **One hue, two weights.** Structure and attention are not different colours; they are
  the same colour turned down and turned up. Which is also why the outline's guides have
  no preference of their own: there was one, its only possible answer was "some grey", and
  it left the product with two unrelated colours doing one job.
- **Luminance separates; a hairline closes.** Surfaces step 2–4% apart. A surface that
  *floats* or that the reader *acts on* is also bounded by one hairline, because a large
  pale rectangle with no edge is a boundary the reader has to infer.
- **A control is raised or inset.** A button is above the page; a field is set into it.
  Flat rectangles of `surface-2` are not controls — that is the hover colour.
- **Two complete modes from one declaration** — hue and chroma are constant per mode.
- **Chrome is small, named, and permanent** (§ Disclosure); every other verb lives in the
  `⌘K` palette, which is what licenses the bareness and therefore never regresses.
- **The user's writing is the typographic top** — chrome is 14px or smaller, at weight 400.
- **A preference can be free where the system can guarantee it.** The accent's hue is the
  reader's because holding its lightness holds its whole row of the contrast table; a
  colour choice that could produce an illegible interface is not offered at all.

## Principles

1. **Structure is the ornament.** A device that encodes nothing true does not ship.
2. **One signal per state** — a fill *or* a rule *or* a raise. Colour is the one required
   second: a tint is legal only where a shape or word already says the same thing.
3. **No token without both modes.** Alpha-on-canvas ink is banned — it cannot invert.
4. **Every capability has one command and one pointer route** — enforced by a test.
5. **Nothing is hidden until it can be found**: a hover-gated control is also in the
   palette, pinned on touch, and revealed on focus.
6. **The primary verb of a surface is never hover-gated.** Search, and a journal's date
   stepper, are permanent — they are what the surface is for.
7. **Silent when steady, plain when not** — saved, online, and on-today render nothing;
   deviations are unbordered text, never a `title` attribute alone.
8. **Nothing below the outline is chrome** — the region under the last block is a live
   append target; no form may be mounted there.
9. **No effect the compositor cannot afford.** A `backdrop-filter` over the writing
   promotes the whole scroller to a layer that re-rasterises every frame, which shows up
   as sub-pixel jitter in the rect of every control on the page. Blur is legal only on a
   full-screen scrim, where nothing behind it is being pressed.

## Color

**Modes are CSS-only.** `prefers-color-scheme` applies to `:root:not([data-theme="light"])`;
an explicit `data-theme` wins both ways; a pre-paint script applies the stored choice.
JavaScript never decides a colour; `color-scheme: light dark` keeps native controls on theme.

**Roles.** `canvas` is the writing surface; `surface-1/2/3` step inward for panels, hover,
and pressed; `rail` sinks below the canvas in both modes so chrome recedes; `overlay` is
anything floating; the three inks are the text strengths. `accent` is reserved for actions,
links, carets, selection and drop, the current place, and the branch. `danger`, `ok`,
`attention` and `info` name states; categories are distinguished by shape, position, or
label.

**Where the accent appears at rest.** The current rail row (a tint plus an accent glyph),
a primary button, a caret, the selection ribbon, the branch through the outline and the
bullets it lands on, an open control's ring, a focus halo, and a tag under a block. Nowhere
else — it is not a hover colour and not a decoration. A tag earns it on the same grounds a
link does: it is the one run of characters in a line of writing that is a *reference*
rather than words, and the product has exactly one colour for "this leads somewhere". Which
is also why a tag chip's press may not destroy anything — see § Component Rules / Tags.

**Two strengths, and they are not interchangeable.** `accent` is tuned for a *mark* — a
caret, a filled button, a 2px stroke. `accent-quiet` is the same hue with the chroma pulled
back and the lightness stepped the other way, for the one place the accent lands inside a
sentence: a tag. At full strength a tag became the loudest thing on a line whose subject is
the writing. It is the more legible of the two, not the less — 5.66–6.40 on `canvas` across
the whole hue circle in light mode, 7.81–8.51 in dark.

**A state tone is never the accent.** The five steps a preference may name are `neutral`,
`info`, `ok`, `attention` and `danger` — and `info` exists precisely so that none of them
is the accent. A tone names a step in a closed ordered scale (how soon a date is, how urgent
a task is); the accent names where the reader is and what they can act on. While a tier
could name the accent, the shipped `upcoming` default moved every time somebody chose a
different accent, and two unrelated meanings shared one colour.

**The state palette.** Task status and priority earn tones because they are closed, ordered
enumerations — one tone per step, aliased from the tokens above. Five rules: the shape says
it first (every tinted mark is legible in greyscale); the unstarted step declines a tone; a
tone may fill its own mark and tint its own chip, never a row, band, panel, or body-size
text; a settled state inverts (`done`/`cancelled` fill their disc and cut the mark out in
`--on-tone` — the one two-colour glyph); a key's mark is untinted.

**The tone map.** A colour preference (the date-urgency tints) stores the *name* of a
declared step — `neutral | info | ok | attention | danger` — carried as `data-palette` and
resolved to `--tone` in CSS. A preference can never leave the palette and tints exactly one
surface: tone-derived tokens are declared on the element carrying `data-palette`, never on
`:root`.

**The accent is a hue.** The accent is declared as a lightness, a chroma and a hue, and the
hue — `--accent-h`, written on `:root` pre-paint, default 277 — is the one preference in the
product that names a colour instead of naming a declared step. It is offered as **eight named
steps and nothing else**. A continuous hue rail sat under them for a while and it was the
wrong instrument: the accent is not a quantity anybody tunes, it is one of a handful of
answers, and a slider invites a precision that means nothing here — 214° is not a better
answer than "Blue", it is the same answer with a decision left dangling. Nothing else about it is the
reader's, and nothing else needs to be: everything the accent touches is already written in
terms of `--accent`, so one number moves the caret, the selection, the lit path, every tint
and every focus halo together.

Fixing the lightness is what makes that safe, because contrast is a property of lightness.
Measured across all 360 degrees with the browser's own gamut mapping applied, the worst case
is `accent` on `canvas` 4.81 light / 6.21 dark, `on-accent` on `accent` 4.81 / 6.66, and
`on-tint` on its own tint 6.10 / 6.21 — every one over the 4.5:1 bar, at every hue, in both
modes. So there is no hue a reader can choose that makes the interface illegible, and
therefore no warning, no validation message and no refused colour.

That is the whole argument against an `input type="color"` here: a free RGB picker offers
millions of colours of which most fail AA in one mode or the other, and it would have to
either ship the failures or spend a sentence telling the reader their colour was rejected.
The steps offer only legal answers, and they are painted from `--accent-l` and `--accent-c`
so they show the colours actually on offer in the current mode rather than a rainbow.

**Contrast rules** (verified in CI, both modes). Measured figures on `canvas` at the default
hue: `ink` 16.7 / 15.7, `ink-2` 7.1 / 8.4, `ink-3` 4.9 / 5.1, `accent` 5.6 / 6.3,
`on-accent` on `accent` 5.6 / 6.8; the accent's figures hold to 4.81 / 6.21 at its worst
hue (§ The accent is a hue). From that table: `--ink-3` is legal on `canvas`, `surface-1`, `rail`, and
`overlay` only — 11–14px text on `surface-2/3` uses `--ink-2`. `--attention` is a glyph
tone, held to the 3:1 non-text bar, never used for text. Any label on a tinted fill uses
`--on-tint` (the tone pulled 30% toward ink), which clears AA on every tint in both modes.

## Typography

Self-hosted Pretendard Variable, first in the stack so Korean and Latin share one voice,
precached with the app shell. Tracking is in `em`, zero for body, negative in UI labels and
at 18px+; locale overrides may zero it but never add a sixth size.

- **Five roles are the whole scale.** Block text (`md`, 16/26) is the only 26px line-height
  at weight 400 — chrome and content are different kinds.
- **Weight rests at 400.** The scale used to start at 500, which made every label, row and
  heading arrive at nearly the same weight; rising to 500 now means "this one", and 600 is
  genuinely a heading.
- **Markdown headings** get four steps, anchored under the 30px page title and on the body
  size; `#####` and deeper repeat the body size in `--ink-2`. No heading draws a rule — in
  an outline a full-measure rule under one bullet is a page divider the next row contradicts.
- **The mono voice** is for identifiers only — property keys, graph ids, ISO dates, SPARQL —
  never labels or prose. Shortcut badges are sans, one element per key, hairline-ringed.
- **Numbers are tabular** by default in every control, cell, badge and `<time>`: a number
  that shifts a pixel as it changes reads as the layout moving.
- **Two divider voices.** The group label (12px, 600, +0.06em, `--ink-3`) divides a grouped
  list; the column label (11px, 600, +0.03em) names a table's columns. Both differ from
  their rows in four ways at once, which is what reads as "a different kind of thing".

## Layout

The shell is a two-column grid — 248px rail, `1fr` content — at `100dvh`. The rail collapses
on `⌘\` above 840px and becomes an off-canvas drawer (inert when closed) below.

- **Exactly one region scrolls**: the content container. The shell never scrolls.
- **The top bar is a bar only once there is something above the fold.** At rest it draws
  nothing — it is page margin holding the two or three controls that belong to the window
  rather than to the page. Once the writing scrolls under it, it takes the canvas, a
  hairline, and the title of whatever just left the top of the screen. It is a fixed 48px
  and never reflows.
- **Two edges, and each one means something.** A bullet hangs in the margin; the writing
  does not. The page's own material — its name, its notes, its properties — takes the
  page's left edge, and the writing is inset by `text-inset`, the column the bullets hang
  in. This replaces "one left edge", which was the right rule for a document and the wrong
  one for an outline: inset to the same x as the writing, a page's name read as the
  outline's first row — a line of larger text in the same column as every line below it,
  with no bullet and no branch, which is a block that has lost its mark. Outdented, the
  title is the root the tree descends from, and the first bullet hangs directly under its
  first letter. The test is not "how many edges" but "can the reader say what each one is
  for": the page, and the line.
- **The measure is 848px** (~87ch) — wider than the prose ideal because each outline level
  spends one indent of it, and bullets are thoughts, not paragraphs.
- **Breakpoints**: ≤840px drawer · ≤700px settings panes stack · ≤600px gutter 16px and
  every hover-revealed control pins visible at 32px. On touch nothing is hover-gated;
  long-press raises the same context menus as right-click.

## Depth & Shape

Depth is three things used together, never shadow alone: a **luminance step** for a region,
a **hairline** for an edge, and a **cast** for distance.

- **`--e1`** — a field, and anything standing in for one: the resting inset ring, no cast.
- **`--e1-raised`** — a button, a chip, a card, the raised key of a segmented control: the
  ring, a one-pixel lit top edge, and a short contact cast. Pressed removes the cast; it
  never removes the box, because a control that shrinks under the finger has moved.
- **`--e2` / `--e3`** — floating and modal.

**Hairlines are for edges, not for regions.** A bounded object gets one: a floating surface,
a card the reader acts on, an embedded query result, a table's cells, the seam between two
halves of one control, the rail's edge (light mode only), a thematic break in the writing.
Two adjacent regions are never told apart by a line alone, and nothing is drawn as a box
around running text — a focus indicator is a halo of `accent-soft`, never a second silhouette.

**Radius grows with the surface**, so a control is always tighter than its panel. **One
scrollbar**, declared once globally — thin, trackless, ink-relative; no component declares
another, components only reserve gutter.

**Whole pixels.** A glyph centred in an odd-sized box, or in a box whose own size is a
fraction, is a blurred glyph — so icon sizes are even, the boxes that centre them are even,
and a clamp with both a `px` and a `vh` term is ordered so the `px` side wins at ordinary
window heights (`min(520px, 76vh)`, not `min(520px, 68vh)`). A control as wide as its own
text is the one exception: no CSS rounds a run of glyphs, and pinning those widths would be
the stranger decision.

**Rows of one table share their tracks.** Several sibling grids that repeat the same
`grid-template-columns` are several grids, not a table: an `auto` track sizes to each row's
own content and the column they are meant to form comes out ragged. The parent owns the
tracks and the rows inherit them with `subgrid`.

## Motion

Motion explains a change; it never decorates one.

1. **One arrival.** A floating surface fades in, travels `--rise`, and settles from 0.985
   scale — the one animated transform, on the argument that the surface was not on screen a
   frame ago, so nothing is being moved out from under a pointer already travelling toward
   it. Opacity finishes by 40% of the duration, because a panel is read — by a person and by
   the contrast audit — the instant it is visible.
2. **A surface read on the frame it mounts moves only.** A toast arrives unbidden and is
   announced immediately; it translates and never changes alpha, so its text is never
   composited against the page behind it.
3. **Overlays animate in, never out.** A closing surface unmounts immediately.
4. **Surfaces read on arrival do not animate** — page bodies, settings panes and dialog
   bodies mount at full alpha; the scrim fades, the panel arrives. `--dur-view` is only for
   content replacing content inside a box already on screen.
5. **Hover-revealed chrome is instant.**
6. **Named exceptions to "nothing else moves":** the off-canvas drawer (it starts outside
   the viewport), a box's own size (`height`, `grid-template-columns` — content never moves
   relative to its box), the collapse chevron's rotation.
7. **Reduced motion collapses durations to 1ms.** The one exemption is the toast countdown
   bar, which is information, not motion.

## Interaction States

Every control defines all five states.

- **Hover** is `--surface-2` — the one hover colour — with glyphs rising to `--ink`. A
  raised control instead lifts one luminance step and keeps its cast.
- **Focus** is a halo of `--accent-soft` outside the control's own resting edge, so the
  silhouette never changes. Native outlines are suppressed. A borderless typing surface
  (a page title, a block's line, the palette's query) already carries the accent caret and
  takes no halo.
- **Pressed** is `--surface-3` (primary action: `--accent-hover`), and for a raised control
  the loss of its cast. Never a transform.
- **Disabled** is 50% opacity, still in layout, announced, and listed in the palette *with
  its reason*.

**Two kinds of indicator, deliberately different shapes.** A **roving highlight** says where
the next key will land: a rounded `--surface-2` wash the width of the row, in every menu,
option list, listbox and the palette, with `↑↓` to move it, `⏎` to choose, `⎋` to leave; a
chosen value says so with a check, never a second wash; a destructive row keeps its own ink
under a `--danger-soft` wash. A **persistent indicator** says which pane is currently on
screen and must keep saying it while the pointer wanders: a 2px accent rule at the left edge,
used by the settings rail and nowhere else — and by `aria-current` alone, never also by
focus, or a reader tabbing the list sees two identical accent marks and cannot tell which
one is the pane they are looking at.

## Disclosure

**If a control is not on the always-visible list, it may not be permanently visible.**
The list: wordmark, graph switcher (with the graph's initial), the `Search ⌘K` field and its
key badge, `Journal`, `Tags`, page list, `Settings`, the journal's date stepper, the `Today`
pill (off-today only), the save/sync/live slots (nothing when steady), the read-only label,
every bullet, a toast's `×`, and one `⋯` in the top bar generated from the command registry.
The top bar holds no named verbs.

Everything else is **revealed** on hover/focus/`[data-focused]` — always with `opacity`,
never `display`, always also in the palette and pinned on touch; **summoned** — the palette,
settings, pickers, dialogs, and context menus, which hang on the object they act on (the
bullet, the title row), never on a parked button; or **raised** — toasts only: the one
surface the user did not ask for, hence the one always-visible dismiss.

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
  listener, the sheet, and every badge); rebinding refuses duplicates, browser-owned keys,
  and text-field keys. The outline's writing keys are not commands and cannot be rebound.
- **The palette**: it opens on the centre of the window, because that is where the reader is
  looking when they press the key; navigation ranks first; never blank; dates parse in the
  same input (`tomorrow`, `aug 5`, `다음 월요일`); the last row is always a way forward;
  disabled commands are listed with their reasons; closing restores the caret exactly. Its
  foot states the three keys it answers to, which is also what closes the panel so the last
  result row never runs off a rounded edge.

## Component Rules

Architecture-level invariants. Pixel specs live in `app.css` beside the tokens.

- **Rail.** One head: the mark and product name small and quiet above, the graph — with its
  own initial in an accent tile — as the row with weight. Search wears the shape of the
  field it stands in for, with its key badge always showing. The current row is an
  `accent-soft` tint with an accent glyph, because the rail is the one surface scanned for
  "where am I" without being read, and a third grey among three greys is not an answer.
- **Outline.** The bullet is the block's handle (click focuses, drag moves, right-click
  menus), a real `<button>`, and a 20px disc appears under the pointer so the most-repeated
  gesture in the product has a target; the textarea is the row's single tab stop. No row
  fill — the caret is the signal; an empty line is a 40% bullet; the append zone is the
  new-line affordance.
- **The branch.** The path from the root to the caret is drawn, not implied: down each
  ancestor's column, a `branch-turn` corner, a run that ends on the next bullet, level after
  level. Guides alone left the relationship to be inferred from x-position, and at three
  levels deep with siblings between, "which line is mine" is a question the picture did not
  answer. It is drawn **only** on the rows the path reaches — the caret's row and its
  ancestors. An elbow beside every bullet was the first attempt and it was worse: four
  levels deep meant four hooks per row, and a "you are here" instrument drawn everywhere is
  wallpaper. The columns a row merely passes stay quiet 1px guides, drawn as virtualized row
  backgrounds; the branch is one pseudo-element and no DOM, which a virtualized list has
  none of to spare. **Only the part of the stroke still in flight is drawn.** The live path is
  a polyline, so at a row it does not reach exactly one column of it is still descending: the
  column of the deepest ancestor above that row. Drawn as "the first N lit columns" instead,
  every level the path had already turned off was redrawn at full weight, and a sibling four
  levels deep grew three bold stubs standing in the middle of nowhere. A row the path
  *arrives at* draws none of it — there the branch is the stroke. The bullets the stroke lands on take the accent with it, and so does the collapse
  chevron at each turn, which is shown there without waiting for a hover: the subtree the
  reader is inside is the one they are most likely to fold. A collapsed row's halo replaces
  its own descending line.
- **Page name.** A field that wraps: a textarea sized to its content, not an input. A name
  longer than the measure in an input is a name the reader can only get at with the arrow
  keys, and a page's own name is the last thing that should be unreadable.
- **Markdown.** A projection of the block, not a second block: a press opens the source at
  the pressed word, the projection carries the row's tab stop, links follow instead of
  editing. No imported prose theme, no bordered callout, no rule under a heading; raw HTML
  and images never render.
- **Selection.** Caret and block selection never coexist. Row-range based, one continuous
  `--accent-soft` ribbon; a selected descendant is a passenger; bulk verbs are one undo step
  resolved against the visible outline; copy is portable Markdown.
- **Properties.** Metadata, not a form: quiet rows and chips, nothing when empty. One
  contextual picker is the only writing surface (`/`, `⌘P`, context menus, palette rows);
  dates parse words with the native picker as the precision tool; system keys are page info.
- **Tags.** A tag chip has two jobs and they are not the same control. Under a block it is a
  *reference* — bare text in the accent, the `#` at 55%, the product's link underline on
  hover — and pressing it hangs the tag picker on it, because that picker is the one surface
  that writes tags. Inside the picker it is an *entry* in the set being edited, and there the
  press removes, announcing it in place by swapping the `#` for an `×` in the same glyph
  column. Serving both from one control meant the most link-shaped thing on a row was the one
  whose press destroyed something, and the accent would have made that trap worse rather than
  better. A tag whose page is gone is struck through, says so in its accessible name, and
  gives up the accent, because it no longer leads anywhere.
- **Tasks.** Any block with `builtin.task-*` keys — no separate storage or generic rows.
  Status and priority are shape-first glyphs before the text, at one weight and with no fill
  of their own: priority carried a tinted tile for a while, on the argument that three thin
  bars lost against a filled disc, and a tile at the head of a line of writing is the
  loudest box on the row. The bars grew instead. Both marks open the *same* menu wherever
  they are reached from — a line, a list result, a table cell — because one value may not
  have two popups any more than two controls may open different ones (§ Choice). *Wherever*
  includes a row whose block this client has never loaded: a query result names blocks on
  pages that are not resident, and reading one out of the snapshot to decide which control to
  open meant the same value offered four radio rows on a one-page graph and a two-stage
  key/value panel on a real one. The menu is controlled and the press hydrates first, so which
  control opens never depends on what happens to be in memory. Done and cancelled strike the
  line. A moment is a day plus an optional time; a missed one says `Overdue` in words;
  urgency thresholds and tones are the reader's, the step order is not.
- **Query block.** The answer is an *object*: the canvas shows through and one hairline
  closes it, so the question can take the inset `surface-1` fill and the answer can sit on
  the page's own ground. At rest the header is one caption phrase (the control that opens the
  editor) and a filled count that is also the empty state. The builder reads as a sentence in
  rows — a lead column, controls that read as words, one left edge, groups are depth not
  cards, and the two knobs most queries never touch are grouped behind a seam at the end of
  the line; hand-written SPARQL is its own entrance, never a conversion. The result table's
  header is a hairline, not a band, and its rows are separated by the panel hairline. Column
  order, width, visibility, and sort are the saved view data. **A cell is the writing it
  quotes**: the values in a result are blocks — often the line the reader wrote a moment ago —
  so they take the same ink the outline gives them and the header stays the quieter of the
  two, and they sit on their row's centre line, because a row is as tall as its tallest cell
  and hanging every other cell from its ceiling is that difference made visible.
- **Status slots.** Save, sync, live share one language: nothing when steady, a 5px dot
  after 600ms while working, a `--danger` dot with a plain-text reason on failure — each
  failure reported by exactly one surface.
- **Toasts.** For failures with no home on screen: tone as a 16px glyph (never colour
  alone), a countdown bar that pauses honestly, repeats collapse, an opacity-free arrival.
  An action on a toast is always a second route.
- **Settings.** A dialog, not a route (`?settings=…`; Back closes it); two labelled scopes —
  browser-wide and this-graph — as two panes with the seam between them drawn. Every
  appearance choice previews itself at the size it will render. **The dialog is one size,
  whatever section is open**: a `min-height` under a larger `max-height` meant it resized as
  the reader moved down its own nav, so every press in the list moved the list and the row
  the pointer was travelling toward was somewhere else on arrival. The pane scrolls instead —
  and the size is the **nav's**, not the longest pane's. Sized for the pane it stood five
  hundred pixels tall with most sections ending a third of the way down it, and a fixed box's
  white space is permanent in a way a growing box's never was. The section list is the one
  thing here that may not scroll, so it is one of the two things the height answers to; the
  other is the longest pane that is a fixed shape rather than a list, which is the task scale.
  A height that cleared the nav and no more read as tight. **A number in a sentence is not a
  field in a form**: `within [7] days` takes the control-that-reads-as-a-word
  treatment the query builder uses, at the height of everything beside it, so four rows of one
  ordered scale are four rows of one height rather than a scale with a form control in it.
  **A colour is chosen by pressing the colour** — a filled disc per option, all of them on
  screen at once, a tick in `--on-tone` on the chosen one, one press each; never a dropdown
  whose trigger hides the palette behind the word for it. One swatch language for every
  colour in the product, the accent's eight hue steps included — and nothing beside them, no
  slider: the accent is one of a handful of answers, not a quantity to tune. The accent has
  no preview of its own because the product behind the dialog is one.
- **Choice.** Every list of choices opens the same menu the bullet opens — never a native
  `<select>` or `<datalist>`. A trigger keeps the shape of a field and takes an accent ring
  while its popup is up, because that is the only thing that says which control on the line
  the popup belongs to. Native stays where the platform is better: checkboxes, date and time
  inputs. A **colour** is not a list of choices and does not use the menu (§ Settings).
- **Overlays.** All portaled, on one `--z-` scale, dismissed by outside click, `⎋`, and
  selection. Anchored panels share one placement function: below the anchor, flipped above
  when the room is above, `max-height` the room actually left. **Sideways it opens toward the
  middle of the window.** A *point-like* anchor — one narrower than the panel: a chip, an
  icon button, a mark — is a place rather than a field, so its panel grows away from the
  nearer window edge, pinned by `left` on the left half of the screen and by `right` on the
  right half, flipping back only if the chosen side cannot hold it. A *field-like* anchor
  keeps its left edge, because the panel is standing in for it: a combobox list right-aligned
  under its own input, or a slash menu jumping to the far end of the line the caret is at
  the start of, would be worse than anything this rule fixes. Pinned by the edge rather than
  offset by a guessed width, so a content-sized panel still meets the edge it is meant to.
  **An anchor is a thing with a box, or a box.** An element that has left the layout still
  answers `getBoundingClientRect()`, and it answers with zeroes; read as a real anchor that is
  the window's top-left corner, which is where a 360×420 property picker jumped the moment a
  query result replaced the cell it was hung on. So a box with no area is not a position, it
  is the absence of one; a panel whose anchor stops being measurable while it is open stays
  exactly where it is, because there is no better guess than the position the reader is
  already looking at; and a caller whose anchor *cannot* survive the trip hands over the box
  instead of the element. A query result's cell is that caller — pressing it hydrates the
  block it names, hydrating rebuilds the result, and the element the press happened on is gone
  before the panel has measured anything. The press had a place on screen; that is the
  anchor.
- **First light.** The launch screen is the one surface whose job is a first impression
  rather than a place to work: a narrow column centred across the window and seated a little
  above its middle, the mark in an accent tile, each graph a bounded card with its own
  initial, the name field and its verb on one line, and the remote path quiet behind a rule.
  It carries the product's one decorative gradient — 4.5% accent at the top of the viewport —
  and nothing else does.
- **System states.** Under the ~220ms flash threshold show nothing; an empty state is the
  action itself; failure keeps the shell (tombstones render in the page body); read-only
  explains itself in the palette; a rejected command is never silent and never reported
  twice, and error text names the verb, not a code.

## Accessibility Contract

Non-negotiable; enforced by CI (axe, wcag2a/aa, serious + critical, light, dark and mobile).

1. Contrast follows § Color's rules; `--ink-3` and `--attention` respect their bounds.
2. Focus appearance is component-owned: an `accent-soft` halo, never a native outline.
3. Real landmarks (`<main>`, a skip link) and real headings — no uppercase spans.
4. State is never colour-only and never `title`-only.
5. The tree exposes `aria-expanded` and `aria-activedescendant`; the textarea is the single
   tab stop; every collapse affordance is keyboard-reachable.
6. Live regions match urgency: off / status / assertive / alert.
7. Hit targets ≥ 24px, ≥ 32px at or below 600px — which the whole chip family answers to
   as well, and which the icon button and each key of a segmented control grow to on touch.
   A control wrapped in its own `<label>` is measured as the label. Text that ellipsises
   carries the whole of itself in a `title`, because an ellipsis with no way to read the
   rest is a name the reader cannot check.
8. IME composition is guarded before any key handler; `Escape` alone bypasses the guard.
9. Localization: one typed catalog, `lang`/`dir` set pre-paint, logical properties,
   `dir="auto"` for user text; components survive the 2× expansion and RTL pseudo-locales.
   See `architectures/i18n.md`.

## Implementation

Tailwind CSS v4 + shadcn/ui over Radix, layered over these tokens.

- Cascade is explicit: `@layer theme, base, neoseq, components, utilities`, with `app.css`
  imported into `neoseq` so utilities can override bespoke classes.
- One owner per token: `app.css` owns colour, type, radius, elevation and motion;
  `globals.css` only maps them onto shadcn's variables via `@theme inline`.
- One place per global: the scrollbar, the anchored-panel placement, the roving highlight and
  each entrance animation are declared once; reimplementing any of them is a bug.
- Radix supplies behaviour; this document supplies appearance. shadcn focus rings are removed.
- Bespoke class names contain a hyphen, never a bare utility name. `spellcheck="false"` at
  the root — the browser has no dictionary for a graph.

## Do / Don't

**Do**: draw the branch to the caret and leave every other indent a quiet guide · draw only
the part of a path still in flight · use one
hue at two weights rather than two colours for one job · separate by lightness and close with
a hairline · raise a button and inset a field · declare both modes together · reserve the
accent for actions, references, and where you are · speak it quietly inside a sentence ·
render nothing when steady · give every verb a key, a palette row, and a pointer route · keep
a surface's primary verb permanent · reveal with opacity, instantly · open a panel toward the
middle of the window · let a floating surface arrive · hang menus on the object they act on ·
store colour preferences as tone names, and free the one dimension the system can guarantee ·
let a reader choose a colour by pressing it · give a result cell the ink of the writing it
quotes · keep chrome ≤ 14px at weight 400.

**Don't**: separate two regions with a line alone · leave an object the reader acts on
unbounded · ship a flat `surface-2` rectangle as a control · tint categories or chrome glyphs ·
let a tone fill more than its own mark and chip · put `--ink-3` on `surface-2/3` · draw a rule
under a heading inside an outline · animate a transform on anything already on screen · fade a
surface that is read on the frame it mounts · put a `backdrop-filter` over the writing · add a
focus ring that changes a control's silhouette · ship two look-alike controls that open
different popups · give one value two popups · let which control opens depend on what is
resident in memory · hand a panel an element that will not survive the trip · put a
destructive verb on the most
link-shaped thing on a row · draw a "you are here" device everywhere · offer a colour the
contrast table cannot vouch for · pick a colour from a dropdown · let a state tone follow the
accent · put a tile behind a glyph to give it weight · resize a dialog as the reader moves
down its own nav · open a panel at the window edge it is nearest · state a fact twice on one
screen · mount a form below the outline · hover-gate a surface's primary verb · offer a
slider for something that is one of eight answers · read a zero-area box as a place · toast
what the user can already see · declare a token in two files.
