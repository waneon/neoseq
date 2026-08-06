---
version: 2
name: Neoseq Design System
description: The design language for Neoseq, a local-first outliner. Structure is the ornament — the indent thread that carries an outline's meaning is also the graphic signature of the interface. Luminance separates surfaces instead of borders, Pretendard carries the type, one ink-indigo accent carries every action, and both a light and a dark mode ship from a single token declaration. Chrome is deliberately small, named, and permanent; everything else is summoned by ⌘K.

# ─── Tokens ───
# Every token below is declared once per mode in `apps/client/src/ui/app.css`.
# Hue and chroma are held constant across modes; only lightness moves.

colors:
  # Neutrals — warm hue 75/78, chroma 0.003–0.009. Never blue-grey slate.
  light:
    canvas: "oklch(1 0 0)"                      # #ffffff — the writing surface
    surface-1: "oklch(0.985 0.003 75)"          # #fbfaf8 — inset panels
    surface-2: "oklch(0.955 0.004 75)"          # #f2f0ed — hover, chips, badges
    surface-3: "oklch(0.930 0.005 75)"          # #eae7e4 — active / pressed
    rail: "oklch(0.968 0.004 75)"               # #f6f4f1 — navigation rail
    overlay: "oklch(1 0 0)"                     # #ffffff — menus, dialogs, palette
    ink: "oklch(0.255 0.009 75)"                # #25221e — body and headings
    ink-2: "oklch(0.450 0.008 75)"              # #585550 — secondary
    ink-3: "oklch(0.530 0.008 75)"              # #6f6b67 — metadata, placeholders, glyphs
    accent: "oklch(0.500 0.160 268)"            # #3d5abd — ink indigo
    accent-hover: "oklch(0.440 0.160 268)"      # #2e47a9
    on-accent: "oklch(1 0 0)"                   # #ffffff
    danger: "oklch(0.495 0.140 35)"             # #a23c23
    ok: "oklch(0.500 0.120 150)"                # #21763c
    scrim: "oklch(0.255 0.009 75 / 0.28)"
  dark:
    canvas: "oklch(0.175 0.004 78)"             # #11100f
    surface-1: "oklch(0.205 0.005 78)"          # #181715
    surface-2: "oklch(0.250 0.005 78)"          # #23211f
    surface-3: "oklch(0.290 0.006 78)"          # #2d2b28
    rail: "oklch(0.145 0.004 78)"               # #0b0a08
    overlay: "oklch(0.215 0.005 78)"            # #1b1917
    ink: "oklch(0.930 0.004 85)"                # #e9e8e5
    ink-2: "oklch(0.740 0.006 80)"              # #adaaa7
    ink-3: "oklch(0.625 0.006 80)"              # #898784
    accent: "oklch(0.760 0.130 268)"            # #8eadff
    accent-hover: "oklch(0.810 0.110 268)"      # #a2beff
    on-accent: "oklch(0.155 0.004 78)"
    danger: "oklch(0.715 0.130 35)"             # #e8836a
    ok: "oklch(0.760 0.130 150)"                # #6fc884
    scrim: "oklch(0 0 0 / 0.55)"

  # Derived — one declaration, both modes, because they are ink-relative.
  derived:
    line: "10% ink"            # the only three legal 1px lines — see Depth
    line-strong: "16% ink"     # inset ring on overlays that float over content
    thread: "8% ink"           # indent guide at rest
    thread-active: "26% ink"   # indent guide on the focused ancestor path
    halo: "9% ink"             # ring behind a collapsed bullet
    accent-soft: "10% accent (light) / 18% accent (dark)"
    danger-soft: "10% danger (light) / 16% danger (dark)"

typography:
  family-sans: "\"Pretendard Variable\", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, \"Helvetica Neue\", \"Segoe UI\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif"
  family-mono: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
  features: "\"lnum\", \"locl\", \"cv11\""
  optical-sizing: auto
  # Five sizes. Nothing else exists. Weight never exceeds 600.
  xs:  { size: 12px, line: 16px, track: 0em,       weight: 550 }   # metadata, chips, badges
  sm:  { size: 14px, line: 20px, track: -0.005em,  weight: 500 }   # UI default — nav, buttons, inputs, menus
  md:  { size: 16px, line: 26px, track: 0em,       weight: 500 }   # block text and page body
  lg:  { size: 19px, line: 25px, track: -0.012em,  weight: 600 }   # section headings (real <h2>)
  xl:  { size: 33px, line: 40px, track: -0.019em,  weight: 600 }   # page and journal titles (<h1>)
  xl-mobile: { size: "clamp(26px, 6vw, 33px)", track: -0.015em }
  mono-xs: { size: 12px, line: 16px, weight: 550 }                  # property keys, ids
  # A group divider, and the one place tracking goes positive — see § The group label.
  group-label: { size: 12px, line: 16px, track: 0.06em, weight: 600, color: "{ink-3}" }
  weights: { normal: 500, medium: 550, strong: 600 }

spacing:
  sp-0: 2px
  sp-1: 4px
  sp-2: 8px
  sp-3: 12px
  sp-4: 16px
  sp-5: 24px
  sp-6: 32px
  sp-7: 48px
  sp-8: 64px

metrics:
  measure: 848px          # content column; ~87 characters at 16px, minus one indent per level
  gutter: 24px            # 16px at or below 600px
  rail: 240px
  drawer: "min(300px, 84vw)"
  topbar: 44px
  title-row: 44px
  row: 30px               # one-line outline row (16/26 text, 2px padding)
  indent: 24px            # per outline level
  slot: 20px              # bullet slot
  target: 24px            # icon-control hit box (32px at or below 600px)
  append: "min(40vh, 320px)"

radius:
  r-1: 4px                # chips, badges, shortcut keys
  r-2: 6px                # inputs, buttons, menu items, nav rows, shortcut badges
  r-3: 10px               # panels, popovers, cards
  r-4: 14px               # dialogs, command palette
  r-full: 9999px          # the bullet dot, and nothing else

elevation:
  e1: "inset 0 0 0 1px {line}"                                     # inset ring, no cast
  e2: "0 0 0 1px {line}, 0 2px 6px -2px ink/8%, 0 8px 24px -8px ink/14%"
  e3: "0 0 0 1px {line}, 0 4px 12px -4px ink/10%, 0 24px 64px -16px ink/20%"

motion:
  dur-press: 90ms
  dur-view: 120ms                   # one view replacing another
  dur-overlay: 140ms
  dur-disclose: 180ms
  dur-size: 220ms                   # a box growing to meet its content
  ease-out: "cubic-bezier(0.4, 0, 0.2, 1)"
  ease-size: "cubic-bezier(0.2, 0, 0, 1)"
  entrance-property: opacity        # transform is never animated. Anywhere.
  # The two properties that may animate besides opacity, both argued in § Motion:
  # a box's own size, and the rotation of a disclosure chevron.
  size-properties: [height, grid-template-columns]
  rotation: "the collapse chevron only"
  reveal: 0ms                       # hover-revealed chrome is instant
  reduced-motion: honoured

layers:
  content: 0
  scrim: 25
  drawer: 30
  dialog: 50
  menu: 55
  popover: 60
  palette: 65
  toast: 70

iconography:
  library: lucide
  size: 14px              # 16px for the rail and the palette
  strokeWidth: 2
  color: "{ink-3}"
  color-hover: "{ink}"

components:
  topbar:      { height: 44px, background: "{canvas}", border: none, edge: "fades in on scroll" }
  rail:        { width: 240px, background: "{rail}", typography: "{sm}" }
  nav-row:     { height: 32px, radius: "{r-2}", rest: "{ink-2}", hover: "{surface-2}", active: "{surface-3} + {ink} + 550" }
  btn:         { height: 32px, radius: "{r-2}", typography: "{sm}", weight: 550 }
  btn-primary: { background: "{accent}", text: "{on-accent}", hover: "{accent-hover}" }
  btn-quiet:   { background: transparent, text: "{ink}", hover: "{surface-2}" }
  btn-danger:  { background: transparent, text: "{danger}", hover: "{danger-soft}" }
  icon-btn:    { size: 24px, radius: "{r-2}", glyph: "{ink-3}", hover: "{surface-2} + {ink}" }
  input:       { height: 32px, radius: "{r-2}", background: "{canvas}", ring: "{e1}", focus: "{surface-2} fill + {e1} — see § Interaction States" }
  menu-select: { height: 32px, radius: "{r-2}", trigger: "{input}", menu: "{overlay} — the same menu a bullet opens", open: "{surface-2} fill + {e1}", max-height: 320px }
  panel:       { background: "{surface-1}", radius: "{r-3}", border: none, padding: "{sp-4}" }
  overlay:     { background: "{overlay}", radius: "{r-3}", elevation: "{e2}", layer: "{layers.menu}" }
  dialog:      { background: "{overlay}", radius: "{r-4}", elevation: "{e3}", layer: "{layers.dialog}" }
  palette:     { width: 640px, top: 12vh, radius: "{r-4}", elevation: "{e3}", layer: "{layers.palette}" }
  menu-item:   { height: 30px, radius: "{r-2}", typography: "{sm}", highlight: "{surface-2}", shortcut: "{kbd} plain" }
  chip:        { height: 20px, padding: "0 6px", radius: "{r-1}", background: "{surface-2}", text: "{ink-2}", typography: "{xs}", border: none }
  # Sans, not mono, and one element per key: a mono face draws ⌘ ⇧ ⌥ at a different
  # cap height than a letter, and with no separator `⌘K` reads as one glyph.
  kbd:         { min-width: 20px, height: 18px, radius: "{r-1}", background: "{surface-2}", text: "{ink-2}", typography: "{xs} sans", gap: 3px, part-min-width: 1ch, plain: "no fill — menus and tables", border: none }
  bullet:      { dot: 5px, slot: 20px, target: 24px, rest: "{ink-3}", hover: "{ink-2}", focused: "{ink}", collapsed: "4px {halo} ring", empty: "40% opacity", cursor: pointer, role: "handle — click, drag, right-click" }
  chevron:     { box: 16px, glyph: 12px, centre: "the middle of the indent column left of the bullet", fill: none, collapsed: "rotate(-90deg) over {dur-disclose}" }
  selection:   { fill: "{accent-soft}", shape: "one square continuous ribbon", gutter: "quiet page margin through every row", drop: "2px {accent} rule at the target depth" }
  settings:    { width: 820px, scopes: 2, nav: 168px, url: "?settings=<section>" }
  shortcut-key: { height: 24px, radius: "{r-1}", typography: "{mono-xs}", recording: "{accent} fill", touch: 32px }
  thread:      { width: 1px, colour: "{thread}", active: "{thread-active}", offset: "{slot}/2" }
  save-slot:   { saved: "nothing", saving: "5px {ink-3} dot after 600ms", unsaved: "5px {danger} dot + reason + Retry" }
  toast:       { width: 360px, radius: "{r-3}", background: "{overlay}", elevation: "{e2}", layer: "{layers.toast}", anchor: "top-right, below the top bar", icon: "16px — info ⓘ {ink-2} / success ✓ {ok} / danger ⚠ {danger}", entrance: none, countdown: "2px bar, 4s / 6s / 10s by tone", dismiss: "always visible" }
  overflow:    { trigger: "{icon-btn} ⋯, top bar, last", menu: "generated from the command registry" }

---

## Overview

Neoseq is a local-first outliner. Its subject is not documents — it is **structure**:
a thought indented under another thought, a day that holds what happened in it, a
tag that turns a line into a record. The interface is built from that material.

**The signature is the thread.** In an outline, meaning lives in the vertical line
that runs from a parent bullet down past its children. Neoseq draws that line
explicitly, at 8% ink, and lights the path to whatever you are editing at 20%. The
same 1px thread language is the only line permitted anywhere else in the product —
the rail's edge, the palette's divider. Structure is the ornament; nothing else is
allowed to be decorative.

**Everything around the thread is quiet on purpose.** Surfaces separate by a 3–5%
step in lightness rather than by borders, so a panel reads as a change in depth
instead of a drawn box. Self-hosted Pretendard gives Korean and Latin writing one
consistent voice across platforms. One colour — an ink indigo — carries every action,
link, caret, and structural drop, and it is the only
chroma in the interface. Both a light and a dark mode ship from a single token
declaration, because a tool you write in at night is a tool you write in at night.

**Chrome is small, named, and permanent.** The parts of the interface that are always
visible were chosen one at a time and are listed in [Disclosure](#disclosure). Every
other verb lives in the command palette, reachable by `⌘K` and from a `Search` row that
is always in the rail. That trade is the whole design: the palette is what licenses an
interface this bare, so the palette ships first and is never allowed to regress. The
writing surface's own top bar holds no named verbs — only durability, the read-only
lease, both of which render nothing when there is nothing to say, and one `⋯` that
opens the palette's own contents for a user who has not met `⌘K` yet.

**Key characteristics**

- The indent thread as the product's one graphic device, functional before decorative
- Luminance-only separation; exactly three 1px lines exist in the entire product
- Two complete modes from one declaration — hue and chroma fixed, only lightness moves
- Pretendard Variable at five sizes, weight capped at 600, tracking in `em` and only above 19px
- One accent, ink indigo, and no second structural colour ever
- A mono voice reserved for identifiers: property keys, graph ids
- Silence in the steady state; the interface speaks only on deviation
- Nothing below the last block is chrome

---

## Principles

1. **Structure is the ornament.** The only decorative-looking element in the product
   is the indent thread, and it is load-bearing. If a graphic device does not encode
   something true about the content, it does not ship.
2. **Luminance separates; lines do not.** Stacked surfaces differ by 3–5% lightness.
   A 1px line is legal in exactly three places (§ Depth). Every other border is a bug.
3. **No token without both modes.** A colour declared for one mode only is incomplete.
   Alpha-on-canvas ink is banned outright — it cannot be inverted.
4. **One signal per state.** Active is a fill *or* a rule *or* a weight — never all
   three. Focus is one outline, not an outline plus a ring plus a recoloured border.
5. **Every capability has one canonical command and one pointer route.** A user who
   never learns a shortcut loses speed, never capability. This is enforced by a test.
   A palette row counts as that route only because the palette itself has a permanent
   pointer affordance (`Search`, in the rail); `Undo` and `Redo` are the two verbs that
   rely on it, having given up their top-bar buttons.
6. **Nothing is hidden until it can be found.** No control may be hover-gated unless
   it is also reachable from the palette, pinned on touch, and revealed on focus.
7. **Silent when steady, plain when not.** `saved`, online, and on-today render
   nothing at all. `saving`, `unsaved`, read-only, and off-today are always visible as
   unbordered text. No state is ever carried by a `title` attribute alone.
8. **Nothing below the outline is chrome.** The region under the last block is a live
   append target and a reserved slot for linked references. No form may be mounted
   there, ever.

---

## Color

### The two modes

Mode resolution is **CSS-only**. `@media (prefers-color-scheme: dark)` applies to
`:root:not([data-theme="light"])`; an explicit `[data-theme="dark"]` or
`[data-theme="light"]` on the root element wins in both directions. A pre-paint inline
script in `index.html` applies the stored choice so there is no flash. JavaScript never
calls `matchMedia` to decide a colour — a browser without JS, and a test harness whose
`matchMedia` always reports `false`, must still get the right theme.

`color-scheme: light dark` is declared on the root. That is what makes native
`<select>` menus, the native date picker, form controls, and scrollbars follow the
theme — the single most common tell of a web app that only pretends to have a dark mode.

### Roles

| Token | Role |
|---|---|
| `--canvas` | The writing surface. The page body, the top bar, the content column. |
| `--surface-1` | A quiet inset panel on the canvas: a settings section or graph card. |
| `--surface-2` | Hover wash, chips, shortcut badges, a shortcut's own key. The one hover colour. |
| `--surface-3` | Active/pressed, and the current navigation row. |
| `--rail` | Navigation. One step away from the canvas in both modes, in opposite directions. |
| `--overlay` | Anything floating: menus, popovers, dialogs, the palette. |
| `--ink` | Body text, block text, headings, the value the user typed. |
| `--ink-2` | Secondary text: nav rows, property values, menu items, hints. |
| `--ink-3` | Metadata, placeholders, group headers, resting icon glyphs. |
| `--accent` | Links, the primary action, carets, selection/drop state, and the active thread. Nothing else. |
| `--danger` | Destructive verbs and the unsaved state. Never a fill behind body text. |
| `--ok` | The one affirmative indicator (persistent-storage granted). A dot, not a fill. |

There is no second structural accent, and no decorative palette. If a future feature
needs to distinguish categories, it distinguishes them by shape, position, or label.

### Contrast — the committed table

Measured WCAG 2.1 ratios. **This table is the source of truth: when a component fails
contrast, the table is what you consult, not the component.**

**Light**

| | canvas | surface-1 | rail | surface-2 | surface-3 |
|---|---|---|---|---|---|
| `--ink` | 15.78 | 15.11 | 14.38 | 13.84 | 12.84 |
| `--ink-2` | 7.45 | 7.13 | 6.79 | 6.53 | 6.06 |
| `--ink-3` | 5.28 | 5.06 | 4.81 | 4.63 | **4.30** |
| `--accent` | 6.22 | 5.95 | 5.67 | 5.45 | 5.06 |
| `--danger` | 6.55 | 6.27 | 5.97 | 5.74 | 5.33 |

**Dark**

| | rail | canvas | surface-1 | overlay | surface-2 | surface-3 |
|---|---|---|---|---|---|---|
| `--ink` | 16.11 | 15.43 | 14.58 | 14.26 | 13.02 | 11.49 |
| `--ink-2` | 8.58 | 8.22 | 7.77 | 7.59 | 6.94 | 6.12 |
| `--ink-3` | 5.54 | 5.31 | 5.02 | 4.91 | **4.48** | **3.95** |
| `--accent` | 9.03 | 8.65 | 8.17 | 7.99 | 7.30 | 6.44 |
| `--danger` | 7.44 | 7.13 | 6.74 | 6.59 | 6.02 | 5.31 |

`--on-accent` on `--accent`: 6.22 light / 8.92 dark. On `--danger`: 6.55 / 7.35.

> **The one hard rule.** `--ink-3` is legal on `--canvas`, `--surface-1`, `--rail`, and
> `--overlay` only. On `--surface-2` or `--surface-3` it fails AA, so any 12–14px text
> sitting on a chip, a shortcut badge, a shortcut key, or an active nav row uses
> `--ink-2`. Text at 24px+, or 19px+ at weight 600, may use `--ink-3` anywhere.

---

## Typography

### The family is Pretendard

`"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, …`

The pinned Pretendard package supplies one self-hosted variable WOFF2 with `swap`
display. It sits first in the stack so Korean and Latin text keep the same metrics and
voice across platforms; system faces remain resilient fallbacks while the asset loads.
The production Service Worker precaches the font with the rest of the application shell,
so it remains available after the first offline installation without a third-party CDN.

The tracking ramp is tuned for Pretendard and remains deliberately restrained. All
tracking is expressed in `em`, stays at zero for body text, and only goes negative in
UI labels and at 19px and above. That keeps compact chrome crisp without crowding the
user's writing.

The active UI locale sets the document's `lang`, so Pretendard and its fallbacks can
select the right script-specific glyphs through `locl`. Tracking values are defaults
for Latin UI copy, not a mandate for every script; locale/script overrides may reduce
them to zero, but may not introduce a sixth type size. Text containers grow or wrap
for translation and are never sized to an English string.

### The five roles

| Role | Size / Line | Tracking | Weight | Use |
|---|---|---|---|---|
| `xs` | 12 / 16 | 0 | 550 | Metadata, chips, group headers, shortcut badges, save reason |
| `sm` | 14 / 20 | −0.005em | 500 | UI default: nav rows, buttons, inputs, menu items, property values |
| `md` | 16 / 26 | 0 | 500 | **Block text and page body.** The user's own words. |
| `lg` | 19 / 25 | −0.012em | 600 | Real `<h2>` section headings |
| `xl` | 33 / 40 | −0.019em | 600 | Page and journal `<h1>`, tombstone, "Your graphs" |

Nothing else exists. The sizes 9, 11, 13, 15, 17, 20, 22, 26, 36 and 40 that
accumulated in v1 are deleted, along with the 1px collision between a 15px `.btn` and
a 14px shadcn `Button` on the same screen.

**The user's writing is the largest 500-weight text in the interface and the only text
at 26px line-height.** Chrome is 14px or smaller. This is the hierarchy — not size
alone, but the fact that chrome and content are typographically different kinds of thing.

### The mono voice

`ui-monospace, SFMono-Regular, "SF Mono", Menlo, …` at 12px/550 is reserved for things
that are *identifiers rather than prose*: property keys (`task.status`), graph ids, and
ISO dates in the page-info popover. It is never used for body copy, headings, or labels.
This is the interface admitting which of its strings are addresses and which are language.

> **A shortcut badge left the mono voice**, and it is the one thing that has. `⌘`, `⇧`
> and `⌥` are drawn in a mono face at a different cap height and weight than a capital
> letter, so `⌘P` set as one string was two mismatched pieces sharing no baseline —
> and with no separator between them, `⌘K` read as a single four-stroke character. A
> badge is now one element per key, in the UI face, at a 3px gap, each part at least
> `1ch` wide so a glyph and a letter occupy the same column. SF Pro and Segoe UI draw
> the modifier glyphs at exactly the optical size of the letter beside them, which is
> the whole reason this works. A shortcut is a *key* — a physical object — not an
> address; the mono voice was never the right claim about it.

### The group label

Every list in this product that divides into groups had the same defect, and it is worth
stating as a rule because it recurred in seven places. `Application` above
`Appearance · Language · Journal`, `Pages` above the page list, `Anywhere` above the
shortcut rows: in each case the divider and the things it divided were **one type size
and one ink step apart**, and one step of anything is not a hierarchy. The heading read
as the first item of its own list.

A group label is now different from a row in four ways at once — 12px against 14px, 600
against 500, `+0.06em` tracking against none, and `--ink-3` against `--ink`. Four weak
signals in agreement is what reads as "different kind of thing" when no single one of
them can. **This is the only place in the type system where tracking goes positive,**
and that is deliberate: it is what makes a label unmistakable for body copy.

Every group divider in the product uses this one rule — rail groups, settings scopes,
palette groups, shortcut sections, property sections, the diagnostic ledger. None of
them is allowed to invent its own.

---

## Layout

### The shell

```
┌────────────┬──────────────────────────────────────────────────────┐
│  ◣ Neoseq  │                          · save · read-only (44px)   │
│  switcher  ├──────────────────────────────────────────────────────┤
│            │                                                      │
│  Search ⌘K │        ┌──────── 704px measure ────────┐             │
│  Journal   │        │  Wednesday, August 5, 2026 ‹▦›│             │
│            │        │                                │             │
│  Pages   ＋│      ↕ │  • Kickoff meeting notes       │             │
│  · Reading │      ↕ │  │ • Discussed the Q3 roadmap  │             │
│  · Specs   │      ↕ │  │ • Follow up with platform   │             │
│            │      ↕ │  • Reading list                │             │
│  ─────     │        │                                │             │
│  Settings  │        │  (append zone — min(40vh,320)) │             │
│            │        └────────────────────────────────┘             │
└────────────┴──────────────────────────────────────────────────────┘
     ↕ = the selection gutter: one gutter width left of every bullet,
         at every depth, where a drag selects rows.
```

`display: grid; grid-template-columns: 240px 1fr; height: 100dvh`. `100dvh`, not
`100vh` — on mobile Safari the difference is the bottom of the rail sitting under the
URL bar.

**Exactly one region scrolls.** The shell never scrolls. The rail scrolls internally
only when its own list overflows. The content scrolls in one container — not two
nested ones, which prevents the browser from scrolling a focused element into view.
The top bar is static and never reflows: `flex-wrap: nowrap`, fixed 44px.

The rail collapses on `⌘\` above 840px (persisted), and becomes an off-canvas drawer
at `min(300px, 84vw)` at or below 840px. A closed drawer is `inert`, so it leaves both
the accessibility tree and the automated audit.

### Measure

The content column is `848px` (~87 characters at 16px) with a 24px gutter, 16px at or
below 600px.

That is past the 72-character ideal for running prose, and an outline is not running
prose. Two things make the wider column the right one here. **Every level of indent
spends `--indent` before the text starts**, so the measure a block actually gets is
`848 − depth × 24`; at 704px a block three levels down was writing into 632px, and the
nesting an outliner exists for was being paid for out of the line length. And **the
lines are short by nature** — a bullet is a thought, not a paragraph — so the failure
mode the 72-character limit protects against, losing your place returning to the next
line, mostly does not arise. v1's 760px was rejected for being ~85 characters of
*paragraph*; this is ~87 characters of list.

### Breakpoints

| Width | Change |
|---|---|
| ≤ 840px | Rail becomes an off-canvas drawer; `.shell-toggle` appears |
| ≤ 700px | The settings dialog stacks: its scope nav becomes two wrapped rows of pills |
| ≤ 600px | Gutter 16px; `<h1>` clamps; hover-gated targets become permanently visible at 32px |

### Touch

Below 600px, nothing is hover-gated: the date stepper and the calendar trigger are
permanently visible at 32×32, and so is a toast's dismiss `×`.

The two context menus need no touch equivalent of a right-click, because their trigger
is an object that is already on screen: a long-press on a bullet or on the page title
raises the platform's own context-menu event, which is the same one the pointer sends.
Bullet drag and the selection gutter set `touch-action` explicitly — `none` on the
bullet, so a drag moves blocks instead of scrolling the page; `pan-y` on the gutter, so
a vertical swipe there still scrolls.

---

## Depth & Separation

Depth is **lightness**, not shadow and not outline.

| Level | Treatment | Use |
|---|---|---|
| 0 — Flat | A 3–5% lightness step from the surface beneath | Rail vs canvas, panel vs canvas, chip vs panel |
| 1 — Ringed | `--e1` (inset 1px `--line`) | Inputs, the resting edge of a form control |
| 2 — Floating | `--e2` | Menus, popovers, the page-info popover |
| 3 — Modal | `--e3` | Dialogs, the command palette |

In light mode a floating surface is white with a shadow; in dark mode it is *lighter*
than the canvas. That inversion is the whole reason elevation is expressed as tokens
rather than as a fixed shadow.

### The three legal lines

A 1px line may exist in exactly three places, and each is the thread language:

1. The rail's right edge — **in light mode only.** In dark mode the luminance step
   separates, and a line would read as a drawn box.
2. The command palette's input/results divider — and only while results exist.
3. `--line-strong` as an inset ring on an overlay floating over content, where a
   shadow alone cannot resolve the edge.

Every other border in the product is deleted: no bordered cards, no bordered chips, no
bordered status pills, and — emphatically — no dashed empty states.

---

## Shape

| Token | Value | Use |
|---|---|---|
| `--r-1` | 4px | Chips, shortcut badges |
| `--r-2` | 6px | Inputs, buttons, menu items, nav rows, settings tabs |
| `--r-3` | 10px | Panels, popovers, graph cards |
| `--r-4` | 14px | Dialogs, the command palette |
| `--r-full` | 9999px | The bullet dot, and nothing else |

Radius grows with the surface, so a control inside a panel is always tighter than the
panel. A neutral control focus ring **never declares a radius** — it inherits the element's own. v1's
global `:focus-visible { border-radius: 4px }` squared off every rounded control in the
product the moment it was focused, because `app.css` was imported unlayered and
therefore outranked every Tailwind utility.

---

## Motion

Motion explains a change. It never decorates one, and it never moves anything.

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 90ms | Press feedback (colour only — see below) |
| `--dur-view` | 120ms | One view replacing another: a page, a settings section, a dialog body |
| `--dur-overlay` | 140ms | Overlay entrances |
| `--dur-disclose` | 180ms | Inline panel reveals, the drawer, the collapse chevron |
| `--dur-size` | 220ms | A box growing to meet its content |
| reveal | **0ms** | Hover-revealed chrome |

### Three rules

**1. Every entrance is `opacity: 0 → 1`. Nothing animates `transform`, `scale`, or
`translate`.** This is a correctness rule, not a taste one. A moving target is
unclickable, and automation reports it as unstable. Press feedback is a
background-colour change, not a `scale(0.97)`.

> **The one exception, named on purpose:** the off-canvas drawer at or below 840px
> translates in from outside the viewport, because "off-canvas" *is* a position and
> fading a navigation panel in place reads as a glitch. It is safe precisely because
> it starts outside the viewport — nothing inside it was reachable a moment earlier —
> and because the closed drawer is `visibility: hidden`, which flips only at the ends
> of the transition, so it is either fully absent from the accessibility tree and the
> audit, or fully arrived. No other element in the product may animate a transform.

> **Two properties besides `opacity` may animate, and they are both named here.**
>
> **A box's own size** — `height`, and the rail's `grid-template-columns` — because
> animating it is what *prevents* a moving target rather than what creates one. When the
> diagnostic recorder switched from Standard to Enhanced it resized the dialog by ~200px
> in a single frame: the panel re-centred in the viewport and `Start recording` left from
> under a pointer already travelling toward it. When `⌘\` collapsed the rail, the entire
> writing surface jumped a quarter of the window sideways. In both cases the content does
> not move *relative to its box* — the box grows or shrinks to meet it, and everything
> inside stays exactly where it was in the box's own coordinates. A `transform` would have
> scaled the text; a `height` does not. Size transitions use `--dur-size` and
> `--ease-size`, and the wrapper clips only while it is between two heights.
>
> **The collapse chevron's rotation**, and only that one glyph. A disclosure chevron *is*
> a direction; swapping `ChevronRight` for `ChevronDown` changed the mark with no
> indication of which way it went, on the one control in the outline whose entire job is
> to say "there is more underneath". It is a 16px square that nothing travels toward while
> it turns. No other element rotates.

**2. Overlays animate in, never out.** A closing menu unmounts immediately. A lingering
ghost at 40% opacity is a target that no longer works, and an automated contrast audit
will read it mid-fade and fail it.

**3. Surfaces that are read the instant they appear do not animate at all.** The graph
picker, Settings, the page body and the shell content are audited the moment they
mount; a container fading in at partial alpha composites its text against the
background and fails contrast for every child. The same applies to a dialog, the
command palette, and every inline disclosure: **the scrim fades, the panel does not.**
Prefer no animation to one that has to finish before the surface is legible.
`enter-fade` survives only for scrims, menus, tooltips and option lists — surfaces
whose arrival is itself the message.

> **What `--dur-view` is for, and why it is safe.** A page replacing another page, a
> settings section replacing another section, a dialog body replacing another body: these
> are containers that were *already* on screen, already the right size, already read. The
> content inside them changes with nothing to attribute the change to, which reads less
> like arriving somewhere than like the surface glitching. 120ms of opacity is enough to
> say "this is different content" and is over long before anything — a user, a live
> region, or the contrast audit, which needs longer than that just to inject itself — can
> read it. Rule 3's concern is a surface that has to *finish* animating before it is
> legible; at 120ms nothing does.

> A toast looks like it belongs on that list and does not. Its arrival *is* the message,
> but it is also read the instant it lands — by the user, by a live region, and by the
> audit, which caught a 140ms `enter-fade` mid-flight and failed the toast's own text
> against the page behind it. Toasts do not animate.

**4. Hover-revealed chrome is instant.** A 120ms fade on a summoned control lags the
pointer down a virtualized list and reads as lag, not polish.

> **The one animation that is information.** A toast's countdown bar is not an entrance
> and not decoration: it is a reading of how much of the report's window is left. It
> animates a `width` rather than a transform — so rule 1 still holds — it pauses exactly
> when the timer pauses, and it is the single element exempted from the reduced-motion
> collapse below. Forcing it to 1ms would empty the bar instantly while the toast stayed
> up for another six seconds, which spares a reduced-motion user no movement and shows
> them something false instead.

### Reduced motion

`prefers-reduced-motion: reduce` collapses durations to 1ms **and** neutralises
`tw-animate-css`'s enter transforms (`--tw-enter-translate-*`, `--tw-enter-scale`), so
a reduced-motion user gets no motion rather than an instant snap from an offset. It
must not touch `scroll-behavior` globally, and it restores `.toast-timer`'s real
duration for the reason given above — the only exemption in the product, and one that
has to be re-argued before a second is added.

---

## Iconography

One monochrome family ([lucide](https://lucide.dev)) at **14px** in chrome and 16px in
the rail and palette, stroke width 2.

- Resting `--ink-3`, rising to `--ink` on hover and in the active nav row.
- **An icon may carry meaning where a colour alone could not.** The three toast tones are
  the case: `ⓘ` / `✓` / `⚠` at 16px in the tone's own colour, because a 5px coloured disc
  distinguishes "failed" from "done" only for a reader who has learned which colour is
  which, and not at all for one who cannot tell the two apart. See § Toasts.
- **No emoji, and no fullwidth or ASCII glyph standing in for an icon.** v1 shipped a
  U+FF0B FULLWIDTH PLUS as the "add a block" affordance beside a lucide `PlusIcon` for
  the same concept in the rail.
- Every icon-only control carries an accessible name, and `aria-keyshortcuts` when it
  has a binding. Icons beside a text label are `aria-hidden`.

---

## Interaction States

Every interactive element defines all five. A control that styles only its default
state is unfinished.

| State | Treatment |
|---|---|
| Default | Per component |
| Hover | `--surface-2` — the one hover colour in the product; glyphs rise to `--ink` |
| Focus (controls) | `outline: 2px solid var(--ink-3); outline-offset: 2px` — achromatic and keyboard-only |
| Focus (fields) | `--surface-2` plus the resting `--e1` edge; borderless writing surfaces use their caret or active thread |
| Pressed | `--surface-3` (or `--accent-hover` for the primary action). No transform. |
| Disabled | 50% opacity, pointer events off, still in the layout, still announced, and in the palette still listed **with its reason** |

> **Why focus is achromatic.** Indigo names an action, a caret, or a structural drop.
> Reusing it on every field made ordinary navigation read as a succession of actions and
> put a blue frame around controls opened with the pointer. Fields now change luminance
> while keeping their resting edge; keyboard-focused controls use a neutral ink outline.
>
> Two kinds of surface are excluded and each says so instead. A **borderless typing
> surface** that looks like text rather than like a field — a 33px page title, a block's
> line, the palette's query — already carries the `--accent` caret, and takes a
> `--surface-2` wash where the field would otherwise be invisible; a ring drawn around
> running text at display size is precisely the drawn box § Depth forbids. A **focus
> container** — a dialog, a menu, a toast, the outline viewport — is not a control at all:
> it takes focus so its contents have somewhere to send keys, and what has focus is the
> thing inside, which says so itself.

Hover and keyboard focus share one highlight in menus, option lists and the palette, so
"where am I" never has two answers. v1 had six hard-coded hover greys
(`rgba(0,0,0,0.05)`, `0.06`, `0.08`) and an active nav row 1% away from its own hover
state; there is now one token.

---

## Disclosure

This section is the contract that answers "why does this app feel cluttered". It is
enumerative on purpose: **if a control is not on this list, it is not allowed to be
permanently visible.**

### Always visible

| Control | Where | Why it earns permanence |
|---|---|---|
| Wordmark + mark | Rail, top | Names the product once, where a product name belongs |
| Graph switcher | Rail | Names where you are; the only route between graphs |
| `Search` (`⌘K`) | Rail | The single affordance that licenses everything below |
| `Journal` | Rail | The primary daily destination |
| Page list + `＋` | Rail | Navigation, and the only pointer route to a new page |
| `Settings` | Rail footer | Workspace-level, deliberately away from daily use |
| Save slot | Top bar | **Renders nothing when saved.** Present only on deviation |
| Diagnostic recording | Top bar; picker upper-right | **Renders only while recording.** Privacy-sensitive state must remain visible |
| Read-only label | Top bar | Only in read-only mode |
| Bullet | Every outline row | The block's own handle: caret, drag, and its menu |
| `Today` pill | Journal title row | Only when the date is not today |
| Toast dismiss `×` | On the toast | The user did not ask for the surface; closing it must not be a discovery |
| `⋯` overflow | Top bar, last | The conventional place to look for "what else can this do" — see below |

The top bar holds **no named verbs**. Everything it used to carry either moved into the
rail (`Search`) or gave up its button for a keyboard binding and a palette row (`Undo`,
`Redo`) — see Principle 5 for why that is allowed and what pays for it.

> **The one `⋯`, and what it is for.** Principle 5 says the palette counts as a pointer
> route *because the palette has a permanent pointer affordance*. `Search` in the rail is
> that affordance, and it is honest as far as it goes: it licensed the emptiness for
> everyone who already knew a command palette was a thing to look for. For everyone else,
> an interface with no menu anywhere has no answer to the first question a new user asks,
> which is not "how do I search" but "what can this do".
>
> So there is one `⋯`, at the end of the top bar, where every application this one
> resembles puts it. It is a **summoned** surface, so § Summoned only still holds and the
> bar still carries no named verb; what it adds is a conventional entry point. It is
> **generated from the command registry**, not hand-listed, so every row's label, icon,
> keyboard badge and disabled reason is the one the palette shows for the same verb, and a
> verb that stops existing stops appearing in it. It cannot drift, and it cannot become
> the only route to anything.

### Revealed on hover, focus, or `[data-focused]`

Date stepper and calendar trigger · collapse chevron · tag remove `×` · graph card `⋯` ·
the rail's `⌘K` badge · the append zone's faint bullet · a shortcut row's reset. Every
one of these is also in the palette or in Settings, pinned visible at or below 600px, and
revealed on `:focus-within` — and revealed with `opacity`, never `display` or
`visibility`, so keyboard and automation can always reach it.

### Summoned only

The command palette · the shortcut sheet · Settings · a block's menu (right-click its
bullet, or `⇧F10` from its text) · the page's menu (right-click its title row) · page
the property picker · the tag picker · tagged-block defaults · page info ·
diagnostics · every confirm dialog.

A context menu is summoned *from an object*, which is what makes it different from a
hidden button: the bullet and the title are permanently visible and permanently the
subject, so nothing has to be discovered except the gesture — and every verb inside is
also a palette row or a documented key.

### Raised, not summoned

Toasts are the one exception to this list, because the user does not ask for them: the
interface does, when something failed where nothing on screen would have shown it. They
are exempt from the permanence rule for the same reason they are allowed at all — they
are not there. See § Toasts for what is allowed to raise one.

### Deleted outright

- The `JOURNAL` eyebrow above the journal title — the rail already says where you are.
- The `2026-08-04` subtitle under `Tuesday, August 4, 2026` — the same fact, twice.
- The visible native date field in the journal header — a third statement of the date.
- Labelled `Undo` / `Redo` text buttons in the top bar.
- The bordered `Saved locally` pill.
- The `＋ Add a block` button — the region below the last block *is* the button.
- All nine uppercase eyebrow pseudo-headings, promoted to real `<h2>`s.
- The dashed empty-state box on the graph picker.
- System property rows (`page.kind`, `journal.date`, `system.created-at`) from the
  property list; they are page *info*, not page *properties*.
- The outline row's `⋯` and the title row's `⋯`. Both menus survive; their trigger is now
  the object they act on. Two permanent buttons for two menus that were always *about*
  something already on screen was one indirection too many.
- The top bar's search pill, `Undo` and `Redo`. Search moved to the rail beside the other
  destinations; the two history verbs kept their keys and their palette rows.
- `All graphs` in the rail footer — the graph switcher's own last item already says it.
- The derived first-run hint under a one-block outline (`⌘K to search · ⌘/ for
  shortcuts`). It appeared over the empty first line of every new page, which is exactly
  where the user was about to type.
- The `Write something…` placeholder on an empty line. An empty line now says it with a
  fainter bullet; the document belongs to the user, including when it is empty.

### The budget that justifies this

On a journal page at 1440×900, v1 gave the user's single block of writing 30px of
vertical space and the two always-expanded property CRUD forms below it 401px —
**13.4× the pixel area of the user's own text**, on every page, unconditionally. The
rule that follows is Principle 8: nothing below the outline is chrome.

---

## The Command Layer

The palette is not a convenience feature. It is the thing that pays for an interface
this bare, so it ships before any control becomes hover-gated.

### One registry, one listener

```ts
type Command = {
  id: string
  group: "Pages" | "Journal" | "Graph" | "Edit" | "Block" | "App"
  label: string
  keywords?: string[]
  binding?: string           // display form, e.g. "⌘P"
  scope: "global" | "editor"
  when?(ctx): boolean
  disabledReason?(ctx): string | null
  run(ctx): void | Promise<void>
  pointerRoute: string       // REQUIRED — how a mouse user reaches this verb
}
```

`pointerRoute` is mandatory and a unit test fails the build if any entry omits it.
That is Principle 5, mechanised: the palette may never become the *only* way to do
something.

**Key arbitration, in order.** An IME composition guard (`isComposing || keyCode === 229`)
is the first statement in the handler — Korean, Japanese and Chinese input must never
lose a keystroke to a shortcut. Then: an open overlay, then the editor scope, then the
global scope, arbitrated solely by `event.defaultPrevented`. **The global layer only
ever matches bindings that carry `⌘` or `⌃`**, so no bare key can be stolen from a text
field.

### Global bindings — deliberately few, and the user's to change

| Default | Verb |
|---|---|
| `⌘K` | Command palette |
| `⌘P` | Properties of the focused block, or of the page when none is focused |
| `⌘/` | Shortcut sheet |
| `⌘\` | Toggle the rail |
| `⌘,` | Settings |
| `⌘Z` / `⇧⌘Z` | Undo / Redo — a *document* undo |

Every row of that table is editable in **Settings → Keyboard**, and the stored override
is what the listener matches, what the `⌘/` sheet prints, and what every menu row and
palette badge shows — one resolved table, read in six places, so a rebound key cannot
leave a stale hint behind it.

Three rules keep the table honest, and each rejection says which one it hit:

1. **A binding must carry `⌘` or `⌃`.** This is the arbitration invariant from above,
   expressed in the type: the stored shape has no field for "no modifier", so a bare key
   is not representable rather than merely discouraged.
2. **No two actions may share a binding**, and the conflict names the other action.
3. **Two sets of combinations are refused outright.** The ones the browser takes first
   (`⌘W`, `⌘T`, `⌘N`, `⌘R`, `⌘L`, `⌘F`, …), because storing one would record a
   shortcut that can never fire — and the ones every *text field* owns (`⌘A`, `⌘C`,
   `⌘V`, `⌘X`), because those do reach the page and the global layer would happily
   `preventDefault` them. One bad rebinding must not be able to take copy and paste
   away from every input in the product. `⌘P` is the intentional exception: the
   property command claims it only while a page or focused block has registered a
   target; otherwise the browser keeps Print.

Bindings are stored as `event.key`, not `event.code`. `code` is layout-stable; `key` is
what is printed on the key the user actually pressed, and therefore the only thing that
can be shown back to them truthfully.

**The outline's writing keys are not in the table and cannot be.** `⏎`, `⇧⏎`, `⇥`, `⇧⇥`,
`⌥↑`, `⌥↓`, `←`, `→` and `⌫` are not shortcuts to commands — they are what typing in an
outline *is*. The sheet lists them as fixed, and says so.

Undo is scoped deliberately. Outside a text field it is a document undo. Inside a
text field it is the platform's own text undo, because a user part-way through
typing a page title or a property value expects to get their characters back, not
to have the graph rewind under an uncommitted draft. The one exception is the
outline's block textarea, which maps to a document undo — there the text *is* the
document, and that mapping already existed.

Editor-scope bindings belong to the outline and are unchanged: `⏎` new block ·
`⇧⏎` line break · `⇥` / `⇧⇥` indent / outdent · `⌥↑` / `⌥↓` move · `⌫` on an empty block
deletes · `←` / `→` at the text edge collapse / expand.

### The palette

640px at `top: 12vh`, `max-height: 60vh`, a full-screen sheet below 600px. A 52px input
row that keeps DOM focus, then results in groups of 36px rows: label, a `--ink-3` hint,
and a right-aligned shortcut badge.

- **Navigation first.** Fuzzy page-title matches rank above commands, because "go
  somewhere" is what a palette is opened for.
- **Never blank.** An empty query shows recents (MRU) followed by high-frequency actions.
- **Dates parse in the same input.** `today`, `tomorrow`, `yesterday`, `aug 5`,
  `2026-08-05`, `next monday`, `3 days ago` all resolve to a top row that opens that
  journal day. This is why the journal header does not need a visible date field.
- **The last row is always a way forward.** With no match, `Create page "…"`.
- **Disabled commands are listed with their reason**, never omitted — a read-only tab
  should explain itself, not appear to be missing features.
- Closing without navigating restores the caret exactly: `{blockId, selectionStart,
  selectionEnd}`.
- `role="combobox"` with `aria-expanded` / `aria-controls` / `aria-activedescendant`;
  `role="option"` on non-focusable rows; focus trapped; result count announced politely.
- Entrance: opacity only, 140ms. Exit: immediate unmount.

### Teaching, in order of reach

1. The permanently visible `⌘K` pill.
2. A shortcut badge on every palette row.
3. A shortcut column on every dropdown item.
4. The `⌘/` sheet — generated *from the registry*, so it cannot drift, and listing the
   verbs that have no binding along with their pointer route.
5. **No first-run hint.** v2 put a 12px `⌘K to search · ⌘/ for shortcuts` line under a
   one-block outline — directly under the empty first line of every new page, which is
   the one place the user's attention is already committed. The rail's permanent
   `Search` row and its `⌘K` badge teach the same thing without standing in the writing.

---

## Components

### The outline

**Row.** 30px at one line: 16px/26px text with 2px of vertical padding — one notch
tighter than v2, which is what makes a screen of short lines read as a list rather than a
column of paragraphs. `padding-left: calc(var(--gutter) + var(--depth) * var(--indent))`
from CSS custom properties, not an inline style that silently overrides the row's own
padding shorthand, and a matching negative `margin-left` so the row reaches one gutter
further left than its text: that strip is the selection gutter. `cursor: text` across the
text, `default` over the gutter. **No hover fill and no focused-row fill** — the caret is
the signal, and a full-width wash behind the line the user is typing is noise. A
*selected* row is the one exception, and § Selection says why.

**Thread.** One `repeating-linear-gradient` on the row background, offset by half the
bullet slot, sized to `depth × indent`. Zero extra DOM, because the rows are
virtualized. Ancestors of the focused row carry `data-ancestor="true"` and switch from
`--thread` to `--thread-active`, lighting the path from the root to the caret.

**Bullet.** A 5px dot centred in a 20px slot with a 24px hit box achieved by negative
margin, so the target exceeds the mark without moving layout. The dot escalates
`--ink-3` → `--ink-2` on row hover → `--ink` when focused. Collapsed-with-children adds
a 4px `--halo` ring — that ring is the *only* collapsed signal. **Every block shows its
bullet, always.** Hiding the mark on childless rows was considered and rejected: this is
an outliner, the bullet is the genre's signature, and a mark that appears the moment a
child is added is a surprising state change rather than a calmer surface.

**An empty line's bullet drops to 40% and comes straight back** on hover, focus, or the
first character. That is the whole of what an empty line says now, and it is enough: a
sentence of instructions in the user's own document was saying more, in their voice, in
a place they were already looking at.

**The bullet is the block's handle**, which is why it carries three gestures: click puts
the caret in the line, drag moves the subtree, right-click opens the block's menu. Its
cursor is `pointer`, not `grab`. `grab` named the second of the three and it was the wrong
one to name: an open hand promises that pressing will pick something up, so every user who
only wanted to put the caret in a line was told they were about to move their block.
`pointer` names what a press actually does; `grabbing`, set on the whole section once a
drag is genuinely in flight, names the other. It is a real `<button>` and the menu's actual trigger, so the
menu is reachable from the keyboard (`⇧F10` or the Menu key, from the row's text) without
the bullet ever becoming a tab stop.

**Chevron.** 16px box, 12px glyph, absolutely positioned in reserved space to the left of
the bullet so text never shifts. `visibility: hidden` without children; `opacity: 0` until
hover, `:focus-within`, or `[data-focused]`. `←` and `→` at the text edges collapse and
expand and then move to parent / first child. Rows carry `aria-expanded`; the tree carries
`aria-activedescendant` while the textarea remains the single tab stop.

Three things about it are load-bearing and were wrong:

- **It sits in the middle of the indent column immediately left of the bullet**, which is
  the same grid the thread is drawn on: the parent's thread line runs one whole
  `--indent` left of the bullet's centre, so the midpoint between them is `--indent / 2`.
  At its old `-16px` the glyph landed three quarters of an indent out — almost exactly on
  top of the ancestor's thread line, aligned to nothing. It takes a `z-index` because the
  bullet's 24px hit box reaches back over that square, and between the two the chevron is
  the one the pointer came for.
- **It has no fill, in any state.** A 16px grey square behind a 12px glyph is a button
  drawn around an icon that was already legible, and it read as a smudge beside the one
  mark on the row that is meant to carry weight. The glyph rising to `--ink` is the whole
  hover signal.
- **It rotates rather than swapping.** One glyph, `rotate(-90deg)` when collapsed, over
  `--dur-disclose` — § Motion's named rotation exception. The halo grows and shrinks on
  the same clock, so the persistent signal and the summoned one agree.

**Expanding is animated; nothing else in the list is.** It is the one structural change in
the outline with no other trace — rows the user has never seen simply exist on the next
frame, in the middle of a list, with nothing for the eye to follow. The rows *one expand
uncovered* fade up over `--dur-disclose` while the chevron turns, so the two halves of one
gesture read as one thing. Driven by an explicit attribute the editor sets and clears, not
by an animation on mount: a row the virtualizer happened to recycle into view during a
scroll must not fade, or the whole list shimmers while you scroll it.

**Block menu.** No button. Right-click the bullet or the gutter beside it; `⇧F10` from
the row's text does the same. It anchors to the bullet rather than to the pointer,
because it is *about* the bullet. Every item carries its shortcut: `Indent ⇥`,
`Outdent ⇧⇥`, `Move up ⌥↑`, `Move down ⌥↓`, `Properties ⌘P`, `Tags`, `Delete ⌫`. Closing it puts
the caret back in the row's text — Radix would otherwise park focus on the bullet, which
is not a tab stop and cannot be typed into — **unless the verb that closed it has already
moved the caret**. `Add child block` mounts a focused pending row synchronously and
`Delete` hands the caret to a neighbour; restoring it afterwards races them and wins,
which sends the next thing typed into the row the menu was opened on.

With more than one block selected the menu changes subject: `Indent`, `Outdent`, and
`Delete N blocks`. It is the same menu on the same object, answering for the selection
that object belongs to.

**Tags.** On their own 20px line beneath the text, left-aligned to the text edge, only
when present. Borderless: 20px tall, `--surface-2`, `--ink-2`, `--r-1`, with the `#` at
55% opacity but still inside `textContent`. A deleted target is `line-through` **and**
says so in its accessible name — never colour alone. The remove `×` grows from v1's
13×13 to a 24px box, revealed on chip hover.

**Empty and append.** An empty page renders a *fake first line*: one 40% bullet at the
exact gutter position of row 1, no words, no button chrome, `cursor: text`, over a 200px
target. A non-empty page ends in a transparent, textless `min(40vh, 320px)` append target
occupying what was previously dead bottom padding — and approaching it raises the 40%
bullet of the line it would create, at the exact gutter position and baseline that line
will occupy. The affordance is the same mark in both places, which is what makes "a line
starts here" legible without a sentence.

**Both are also the nearest place with nothing on it, and that reading wins.** The empty
region under the writing is the obvious thing to click to get out of a menu, a popover or
a selection — and because it is a real button, doing that used to close the menu *and*
append an empty row nobody asked for, every single time. A press that began while
something was floating over the page only dismisses. Whether something was floating is
sampled on `pointerdown` at the `window` in the capture phase, which is the only listener
that runs before Radix's own dismisser has already removed the layer being asked about.

### Selection

The outline has two kinds of "current", and they are deliberately different things. The
**caret** is where text goes and lives in one textarea. The **selection** is a set of
blocks a structural command acts on. *They never coexist:* taking one drops the other, so
`⌫` can only ever mean one thing.

- **The quiet writing surface is the handle for range selection.** Dragging may begin in
  the row, in its gutter, or in the page margin between the rail and the centered editor.
  A drag that starts in the already-focused textarea remains native text selection; this
  is the stable distinction between selecting words and selecting blocks.
- **It selects by row *range*, not by rectangle.** The rows are virtualized, so a
  rect-intersection marquee would only ever see the handful currently mounted. A range
  between the row the drag started on and the row it is over now covers everything
  between them whether it is mounted or not — and it is also the honest model, because
  an outline row is a line, not an area.
- **No rubber band is drawn.** The selected rows form one square-edged continuous ribbon
  in `--accent-soft`; descendants carried by a selected ancestor join the same ribbon.
  It is the same wash the platform paints behind selected text, one level up: the one
  row fill in the product, and it exists because a selection has nothing else to say it
  while `⌫` and a drag are both waiting on it.
- **`⇧`-click a bullet extends** from the last bullet touched; **`⌘`/`⌃`-click toggles**
  one row. Both are what a list has meant everywhere for thirty years.
- **Dragging any selected bullet moves the whole selection.** A 2px `--accent` rule shows
  where it will land, indented to the depth the drop would take, with a dot at its head so
  the level is legible at a glance. The legal depth range is the outliner rule: at most
  one level deeper than the row above, never shallower than the row below, and never
  inside a collapsed row or inside the moving subtree itself.
- **A selected row nested inside another selected row is a passenger, not a root.** Moving
  or deleting the ancestor already carries it; issuing a second command for the child
  would tear it out of the subtree it just travelled with.
- **The bare keys reach the tree, not a text field.** Every gesture that makes a
  selection also *takes the caret's focus with it* — it blurs the textarea and focuses
  the viewport — so `⌫` can never mean two things at once. Then: `⌫` deletes, `⇥` /
  `⇧⇥` indent and outdent the group, `↑` / `↓` collapse back to a caret at the edge the
  selection was left from, and `⎋` clears the selection **and returns the caret** to the
  row it started on, because Escape means "back to writing".
- **The tree's own focus outline is suppressed.** The viewport is a focus
  *container*, not a control: it is not a tab stop, what has focus is the selection, and
  the selection says so with its own fill. A 2px ring around the entire outline would be
  precisely the drawn box § Depth forbids. Focus is never left there with nothing
  selected — clearing a selection hands the caret back.
- **Collapsing a row drops any selected descendant it just hid.** Every bulk verb resolves
  the selection against the *visible* outline, so a hidden member would make `⌫` and `⇥`
  quietly do nothing.
- **A bulk verb is one document-history step.** Delete, indent, outdent, move, and an
  outline paste cross the graph boundary as one command, so one `⌘Z` restores the action and
  redo reapplies it as a unit.
- **Copy is portable Markdown.** `⌘C` and the selection menu write plain-text list items,
  normalize the shallowest selected row to level zero, preserve descendant indentation,
  and indent continuation lines under their item. Pasting an unordered or ordered
  Markdown list creates real outline blocks; ordinary multiline text remains an in-block
  paste. An empty destination is reused rather than leaving a blank block behind.
- `role="tree"` gains `aria-multiselectable`, rows carry `aria-selected`, and the count is
  announced politely — the highlight is the visible count, so a live region is how it
  reaches a screen reader. It counts the rows a verb will *take*, passengers included, and
  the bulk menu's own `Delete N blocks` counts the same way.
- **Auto-scroll follows the pointer** within 56px of either edge of the scroll container,
  on a frame loop rather than per-move, so a drag past the end keeps extending while the
  container catches up.

### Title row (journal and page, one shape)

44px. `<h1>` at 33px/600 — one step up from v2, so the page's name reads as the largest
thing on the surface rather than merely the boldest. On the right: a hover-revealed
cluster of 24px controls (`‹`, a calendar trigger that calls `showPicker()`, `›`) and a
`Today` pill that is always visible when the date is not today.

**The row is the page's handle.** Right-clicking it — the title included — opens the
page's menu: properties, info, and delete. There is no `⋯`. The keyboard routes are `⌘P`
for properties and the palette's own `Page info` / `Delete page…` rows, which reach the
same handlers, so nothing here is pointer-only. Radix needs something to position
against, so the trigger is a zero-size anchor at the pointer, `aria-hidden` and
unfocusable: it is not a control, it is a coordinate.

The journal's `<input type="date">` stays mounted at all times, value-synced and
focusable, but clipped — it is a real keyboard tab stop and the target of
`showPicker()`, without stating the date a third time in the platform's own locale
format beside a heading that already reads `Tuesday, August 4, 2026`.

A page title is an in-place `<input>` with a pointer cursor and `--surface-2` only while
hovered at rest. Focus removes the wash, switches to the text cursor, and leaves the
`--accent` caret as the editing signal. `⏎` commits and `Esc` reverts. `⏎` also
blurs, and a blur commits, so the commit is guarded against running twice on one draft —
otherwise a refused rename reported itself twice for one keystroke.

A **journal** page has no title of its own: the core stores its day as a property. Reached
through `/journal` the view supplies the heading; reached by id, as a page reference
resolves it, the title row formats that property with the user's chosen date format rather
than falling back to the page id.

### Properties

Properties are document metadata, not a separate form. Non-system block entries render
as quiet two-column rows directly under their Markdown; pages retain a compact strip of
up to four `key: value` chips below the title. An empty bag renders nothing. Keys use the
mono identifier voice, values truncate on one line, and clicking a row or chip opens the
same contextual picker on that key.

The picker is the only property-writing surface:

- `/` in a block opens a one-row command menu. `Add property` removes the slash token,
  persists a pending block if necessary, and opens the picker for that block.
- `⌘P` opens it for the focused block, or the page when no block is focused. The title
  and bullet context menus provide the pointer routes.
- The first stage searches existing and registry keys and can create a validated custom
  key. A custom key adds a type stage; the value stage is derived from that type.
- Existing rows enter directly at the value stage. Repeated values stay individually
  removable, while Clear removes the whole property.
- System keys are omitted and live in page info. Tags keep a separate picker because
  membership and property values are different domain commands.

The picker is portaled and fixed to its invoking row or editor, so it does not resize the
outline or get clipped by virtualization. `Escape` closes without changing slash text;
a successful command closes and restores focus to the invoking document control.

### Save slot

| State | Render |
|---|---|
| `saved` | Nothing. Zero-size box, `aria-live="off"`. |
| `saving` | A 5px `--ink-3` dot, after a 600ms delay so debounced keystrokes never flicker. |
| `unsaved` | A 5px `--danger` dot, the reason as visible 12px text, and a `Retry` button. `aria-live="assertive"`. |

The element stays mounted with its `data-save` attribute in every state. A transient
toast would be wrong here: durability is ambient, and it is also the thing tests wait on.
The notification layer knows this and **stays silent on `dirty_unsaved` and
`storage_full`**, so one failure is never reported by two surfaces at once.

### Diagnostic recorder

Diagnostic recording is summoned from the command palette or Settings. Its modal
starts with a two-choice Standard/Enhanced ledger. Standard is the default;
Enhanced discloses a danger-toned inset with scope and category controls and is
never remembered. While active, the top bar shows one 5px `--danger` dot, the
capture level, and tabular elapsed time; the whole status stops and opens review.
Below 600px the label hides, but dot and time remain. Review uses a wide dialog
with a four-value summary, content policy, annotation, and Save/Discard actions.
Enhanced review inventories the sensitive stream, permits excluding it, and
requires a second confirmation to include it. Nothing is uploaded by the app.

### Toasts

The one surface that is neither always visible nor summoned by the user: it arrives
because something happened. That makes the routing rule the important half of the
component.

> **A toast is for a failure with no home on screen.** If the thing that failed has a
> place the user is already looking — a field, a query block, the save slot, a
> tombstone, a confirm dialog that is still open — the report belongs *there*. What
> reaches the toast layer is what would otherwise be silent: a rejected undo, a
> structural command that simply did not happen, an edit that reverted under the caret,
> a page that failed to load, a `Delete` whose dialog has already closed, a rename the
> core refused, a graph search that could not run.

- **Top-right, below the top bar** (`--topbar-h` + 8px), 360px, `--overlay` on `--e2`,
  above every overlay on the `--z-*` scale — a failure raised while a dialog is open
  still has to be seen. Inset 8px from both edges at or below 600px.
- **The region is `pointer-events: none`; each toast is `auto`.** Almost always it is
  empty, and an empty fixed region that eats clicks is worse than no region at all.
- **Tone is a 16px glyph** in the tone's own colour: `ⓘ` `--ink-2` notice, `✓` `--ok`
  affirmative, `⚠` `--danger` failure. There is no fourth tone and no warning colour, and
  the title still says what happened, so tone is still never the only signal.
  > It was a 5px dot, the save slot's language borrowed wholesale. That works for
  > durability, which has two states the user already knows; it does not work here. A
  > report can be a failure, a plain notice or a confirmation, and a coloured disc
  > distinguishes those only for a reader who has learned which colour is which — and not
  > at all for one who cannot tell the two apart. A glyph is legible before the sentence
  > beside it is read, which on the one surface the user never asked for is the whole job.
  > § Iconography names this as the case where an icon carries meaning.
- **Every report expires, and every report shows how much of its window is left.** A
  2px bar along the bottom edge runs down in the tone's own colour: 4s success, 6s notice,
  10s failure. A failure gets the longest window rather than none at all, because the two
  conditions that genuinely outlive a countdown — unsaved work and a read-only lease —
  have permanent homes in the top bar, so nothing that must persist depends on a toast
  staying up. **The countdown pauses on hover, on focus inside the region, and while the
  tab is in the background**, and a pause *holds* the remaining time rather than
  restarting it: the bar and the timer are the same clock.
- **Repeats collapse** onto one toast with a `×N` counter rather than stacking. The
  stack caps at four, and an unacknowledged error is the last thing evicted.
- **`role="alert"` for a failure, `role="status"` for a notice**, `aria-atomic`, and a
  dismiss `×` that is **always visible**. It is the one control in the product that is not
  summoned: the user did not ask for this surface, so getting rid of it must not depend on
  first working out that hovering reveals a button.
- **An action on a toast is always a second route**, never the only one, and clicking it
  closes the toast — whatever it starts reports its own outcome.
- **No entrance animation.** This was a close call: a toast reads like a surface whose
  arrival is the message, which is what `enter-fade` exists for. It is also read the
  instant it appears, and the contrast audit caught it mid-fade compositing its text
  against the page behind it. § Motion rule 3 decides it.
- **Success is a tone the product almost never spends.** An outcome the user can already
  see gets no toast: a removed chip, a vanished row and a `saved` state all stay silent.

### Settings

Two scopes, and saying which is which is the section's whole job. Half of what used to be
one flat page belongs to the **browser** — appearance, language, how a date is written,
which keys do what, whether storage is persistent — and holds for every graph the user
opens. The other half belongs to **this graph** and travels with it. Presented as one
column, `Delete this graph…` read as a sibling of `Language`.

- **A dialog, not a route.** Settings are an aside: you open them from wherever you are,
  change one thing, and come back to the same block with the same caret. 820px, a 168px
  scope nav on the left, the pane scrolling on the right.
- **Two named groups, each with a real `<h3>`.** `Application` — Appearance, Language,
  Journal, Keyboard, Storage. `This graph` — Graph, Danger zone. Each heading used to
  carry a sentence under its rows explaining how far the scope reached ("These apply to
  Neoseq in this browser, on every graph."); both are gone. Two paragraphs of prose inside
  a 168px navigation column, restating what `Application` and `This graph` already say, in
  a column whose job is to be scanned rather than read. The distinction now rests on the
  two headings and on § The group label's typography, which is where it belonged.
- **Switching sections fades** at `--dur-view`. The pane is a box that is already on
  screen and already the right size; without it, changing sections read as the dialog's
  contents glitching rather than as one section replacing another.
- **The open section is in the URL** (`?settings=keyboard`). The browser's own Back closes
  the dialog, a link can point at one section, and a reload comes back to it. The old
  `/settings` path still resolves, to the journal with the dialog open.
- **The dialog title is the largest thing on the surface**, so a section heading steps
  down to 14px/600 rather than tying with it at 19px.
- **Journal date format carries a live example per option** (`Abbreviated month — Aug 5,
  2026`). A user choosing how their days are written should be reading the result, not
  decoding a label.
- **A shortcut's badge is the control that changes it.** Press it, then press the keys.
  Recording is an `--accent` fill on the badge itself; `⎋` or moving focus away cancels;
  a rejection says which of the three rules it hit. A row whose binding is not the default
  offers a reset, and the section offers `Restore all defaults` only while something is
  customised.
- **`Danger zone` is its own section**, not a red button at the bottom of a scroll.

### Choice

**Every list of choices in the product opens the same surface: the menu a right-click on a
bullet opens.** One `MenuSelect`, one popup, one highlight, one radius, one set of metrics.

This replaced three. On the removed property add row there were three popups side by side:

1. a native `<select>`, whose menu the **operating system** draws, in the operating
   system's palette, metrics and corner radius, which no rule in this document can reach;
2. a `<datalist>` on a text input, whose menu the **browser** draws, in a third style
   again, and which Chrome, Safari and Firefox each interpret differently;
3. the Radix menu, which is the one this design system actually specifies.

Two adjacent controls that look identical at rest and then open two unrelated objects is
the most disorienting thing a form can do.

- **The trigger keeps the shape of a field**, because it is standing in for one: 32px,
  `--r-2`, `--canvas`, the `--e1` inset ring, a 14px chevron at the trailing edge. Open is
  `--surface-2` with the same `--e1` resting edge — the popup is already the loud part.
- **The menu is the block menu**, `--overlay` on `--e2`, matched to the trigger's width so
  a long list does not open as a panel narrower than the control that summoned it. It caps
  at 320px and scrolls; the timezone list is four hundred rows and is why the cap exists.
- **Rows are `menuitemradio`** with the indicator's column reserved whether or not the row
  is the selected one, so the text does not shift sideways as the selection moves down.
- **A value the core holds that is not one of the offered options stays listed**, so
  opening the menu can never silently rewrite it.
- **A field that accepts anything and also offers a list** — the property picker's key
  combobox — filters existing and registry keys while keeping a final explicit create row
  for a valid custom key. Its list is the expected result of summoning the picker, not an
  unsolicited popup beneath document text.

> **The cost, named.** A native `<select>` brings the platform's own picker, the mobile
> wheel, and type-ahead for free. Radix returns type-ahead, roving focus, portalling,
> dismissal and `menuitemradio` semantics; the mobile wheel it does not. One consistent
> surface for every choice in the product was judged worth one platform affordance on one
> form factor. This is the one place § Implementation's "native where native is better"
> was overruled, and checkboxes and date inputs — where the platform genuinely brings
> something a menu cannot — were not touched.

### Overlays

All portaled to the document — a menu anchored inside a scrolling, clipping, transformed
ancestor (the virtualized outline is all three) cannot escape with `z-index` alone. All
on the one `--z-*` scale, which replaces four disagreeing definitions where dialog, menu
and toast were tied at 50. All dismissible by outside click, `Escape`, and selection.

**"Outside click" includes the empty space in the editor**, and that needs stating because
the largest patch of empty space on the page is also a button (§ The outline, Empty and
append). A press that begins while something is floating only dismisses; it does not also
do what that region does.

**`Escape` is decided before the IME guard**, and it is the one key that is. A composition
owns the keyboard outright and for every other key that is correct — losing a keystroke
mid-composition corrupts CJK input. But `Escape` is not a character, it is the way out, and
the browser reports `isComposing` on that keydown too: a user who typed 검색 into the
palette and pressed `⎋` got nothing at all, and the only remaining exit was the pointer. A
modal surface with one focusable element also needs a window-level backstop, because `⇥`
parks focus outside the panel and the panel's own handler never runs again.

---

## Loading, Empty, Error, Read-only

- **Below the flash threshold, show nothing.** Local work usually finishes in well under
  220ms; a spinner inside that window makes fast software feel broken. Past it, fade in
  a quiet spinner with a short label, mounted once — v1 mounted its loading state twice
  on the same open path, each restarting its own timer.
- **Empty states are the action.** The graph picker's empty state is one sentence plus
  the create form as the primary action, not a dashed box containing an instruction that
  points at a form 100px below it.
- **Failure keeps the shell.** A tombstone renders inside the page body with the rail
  and top bar intact. v1 replaced the entire shell with a grey card and one link, so a
  mistyped date cost the user their navigation.
- **Danger is announced as danger.** A data-recovery warning is `role="alert"` in the
  content column with its own gutter, filled with `--danger-soft` and no border — not a
  polite `role="status"` running edge-to-edge under the top bar.
- **Read-only explains itself.** One unbordered `Read-only` label beside the save slot,
  every blocked command listed in the palette with its reason, and — once per session,
  because a 12px label is easy to miss while you are already typing — one persistent
  notice saying the graph is open in another tab.
- **A rejected command is never silent.** If it left no visible trace, it is reported;
  see § Toasts for where. The error text is a sentence naming the verb the user tried
  (`Couldn't indent that block`) over the core's own reason, never a raw error code.

---

## Accessibility Contract

Non-negotiable, and partly enforced by CI (axe, wcag2a/wcag2aa, serious + critical, in
both colour schemes):

1. Contrast follows the committed table. `--ink-3` never touches `--surface-2/3`.
2. One visible focus indicator on every interactive element: neutral outline for
   controls, luminance/resting edge for fields, and caret/thread for writing surfaces.
3. Real landmarks: a `<main>` in the primary view and a skip link. `aria-hidden` never
   lands on the only landmark.
4. Real headings. Every section that looks like a heading is one; no uppercase `<span>`
   doing the job, and no `aria-label` duplicating a visible heading.
5. State is never colour-only and never `title`-only.
6. The tree exposes `aria-expanded` and `aria-activedescendant`; the textarea is the
   single tab stop; every collapse affordance is reachable by keyboard.
7. Live regions match urgency: `off` when saved, `assertive` when unsaved, `alert` for
   corruption and for a reported failure, `status` for a notice.
8. Hit targets are ≥ 24px, and ≥ 32px at or below 600px.
9. IME composition is guarded before any key handler runs.
10. `role="option"` rows are non-focusable `<div>`s, not buttons.

### Localization and bidirectionality

- Product copy, accessible names, descriptions, validation, and live-region messages
  use the same typed catalog contract; translated HTML is never rendered.
- The locale provider sets `<html lang>` and `<html dir>` before interactive content
  appears. A locale change updates visible and assistive copy in one commit.
- Layout uses logical inline/block properties. Directional navigation and hierarchy
  glyphs mirror when their meaning reverses; neutral glyphs do not. User-authored
  text uses `dir="auto"`, independent of the chrome direction.
- Every component must survive the expansion pseudo-locale at twice the English copy
  length and the RTL pseudo-locale without clipping focus, status, or destructive
  confirmation text. Wrapping wins over ellipsis for actions and feedback.
- Locale controls presentation only. Journal timezone, graph content language, stable
  stored values, and search analysis remain separate contracts; see
  [`architectures/i18n.md`](architectures/i18n.md).

---

## Implementation

Tailwind CSS v4 + shadcn/ui over Radix, layered over these tokens.

- **Cascade order is explicit.** `globals.css` declares
  `@layer theme, base, neoseq, components, utilities` and imports
  `@import "./app.css" layer(neoseq)`, so a Tailwind utility can override a bespoke
  class. v1 imported `app.css` unlayered, which meant it silently beat every utility —
  the reason a component had to fight its own card with an inline style.
- **One owner per token.** `app.css` owns `--r-1..4`, the colour ramp and the type
  scale. `globals.css` maps them onto shadcn's semantic variables through
  `@theme inline` and declares nothing of its own. v1 declared `--radius-sm/md/lg/xl`,
  `--font-sans` and `--color-primary` in *both* files with conflicting values.
- **Class names are namespaced by family and never a bare utility name.** A bespoke
  class must contain a hyphen. v1's `<section className="outline">` collided with
  Tailwind's `outline` utility and drew a 1px black box around the entire outliner.
- **Radix supplies behaviour, this document supplies appearance.** Portalling, focus
  trapping, dismissal, roving focus and ARIA wiring come from the primitive; every
  visual property comes from a token. shadcn's `focus-visible:ring-2` and
  `focus-visible:border-ring` are removed so focus is one ring, not three.
- **Native where native is better — and a `<select>` is not.** Checkboxes and date inputs
  stay real form controls, because the platform brings a picker and a mobile wheel that
  nothing here can reproduce. A list of choices brings an unstylable popup instead, drawn
  by the OS in the OS's own language, so it became the one Radix menu every other choice
  in the product uses; § Choice argues it and names the cost.

---

## Do / Don't

### Do

- Let the indent thread be the one graphic device, and light the path to the caret.
- Separate surfaces with a 3–5% lightness step; reach for a border only in the three
  places listed in § Depth.
- Declare every colour in both modes in the same block, and keep hue and chroma fixed.
- Consult the contrast table before styling text on a tinted surface.
- Reserve `--accent` for actions, links, carets, selection/drop state and the active thread.
- Keep chrome at 14px and smaller so the user's 16px writing is the largest 500-weight
  text on screen.
- Use mono only for identifiers: property keys, shortcut badges, ids.
- Render nothing at all for `saved`, on-today, and an empty property bag.
- Report a rejected command through the notification layer, and keep *validation* — what
  the user typed being an illegal value — beside the field that holds it. Those are two
  different kinds of "no" and they belong in two different places.
- Give every verb a palette entry, a shortcut badge, and a pointer route.
- Reveal chrome with `opacity`, instantly, and pin it visible on touch and on focus.
- Give every group of rows a label that differs from them in four ways, not one
  (§ The group label), and let the rows themselves go to full-strength ink.
- Open the same menu for every list of choices, and keep the trigger shaped like the field
  it stands in for.
- Animate a box's *size* when its content is swapped, so the panel grows to meet the
  content instead of jumping the buttons out from under the pointer.
- Let a shortcut badge lay out one element per key, in the UI face, with a real gap.
- Hang a menu on the object it acts on — a bullet, a title — rather than on a button
  parked beside it, and give the same verbs a key and a palette row.
- Let a selection be visible in exactly one way: a fill on the rows it holds.
- Animate `opacity` only, and never animate a container that is measured on mount.
- Keep selects, checkboxes and date fields native; restyle rather than rebuild.
- Let exactly one region scroll, and let the top bar never reflow.

### Don't

- Don't draw a border to separate two surfaces — that is what lightness is for.
- Don't ship a dashed empty state, a bordered chip, a bordered status pill, or a card
  inside a card inside a card.
- Don't introduce a second structural accent, or tint a chrome glyph.
- Don't put `--ink-3` on `--surface-2` or `--surface-3`.
- Don't tune a tracking ramp for a font the app does not actually load, and don't set
  tracking in `px` on a size that clamps.
- Don't animate `transform`, `scale`, or `translate` — not on entrance, not on press,
  not on hover. The two exceptions are named in § Motion and are a box's own size and the
  collapse chevron's rotation; a third has to be argued there before it ships.
- Don't use an accent focus ring. Indigo is reserved for actions, carets, and structural
  drops; keyboard focus uses neutral ink and fields use luminance.
- Don't ship two controls that look identical at rest and open different popups.
- Don't set a modifier and its key as one run of mono text, and don't leave them touching.
- Don't separate a group heading from its rows by one type size and nothing else.
- Don't let a click that dismisses an overlay also fire the button underneath it.
- Don't swallow `Escape` behind the IME guard; it is the way out, not a character.
- Don't let an overlay linger on close, and don't reach for a bigger `z-index` to escape
  a clipping ancestor — portal it.
- Don't state the same fact twice on one screen, and don't render an uppercase `<span>`
  where a heading belongs.
- Don't mount a form below the outline. Ever.
- Don't hover-gate a control that has no palette entry, no touch pin, and no focus reveal.
- Don't communicate a state with a `title` attribute, a colour, or a spinner that
  appears for 40ms.
- Don't swallow a rejected command, and don't report one twice — a failure the save slot
  already owns does not also get a toast.
- Don't leave a control's only route to be a right-click, and don't leave a right-click
  hanging on empty space instead of on the thing it acts on.
- Don't animate anything on a timer except a countdown that *is* the time remaining.
- Don't toast an outcome the user can see, don't put a verb's only route on a toast, and
  don't let a fixed notification region take a click while it is empty.
- Don't hide a system property in the property list — it is page info, not page data.
- Don't declare a design token in two files.
