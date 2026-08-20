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
    attention: "oklch(0.545 0.130 75)"          # #9b6200 — the warm neutral hue, at chroma
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
    attention: "oklch(0.795 0.125 78)"          # #e8b257
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
    scroll-thumb: "20% ink"          # the one scrollbar — see § The one scrollbar
    scroll-thumb-hover: "34% ink"

  # The state palette — aliases only, so the tones stay declared once per mode.
  # See § The state palette for the four rules that keep this from decorating.
  state:
    status-todo: "currentColor"       # it declines a tone
    status-doing: "{attention}"
    status-done: "{ok}"
    status-cancelled: "{danger}"
    priority-low: "currentColor"
    priority-medium: "{attention}"
    priority-high: "{danger}"

typography:
  family-sans: "\"Pretendard Variable\", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, \"Helvetica Neue\", \"Segoe UI\", \"Apple SD Gothic Neo\", \"Noto Sans KR\", \"Malgun Gothic\", sans-serif"
  family-mono: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
  features: "\"lnum\", \"locl\", \"cv11\""
  optical-sizing: auto
  # Five sizes. Nothing else exists. Weight never exceeds 600.
  xs:  { size: 12px, line: 16px, track: 0em,       weight: 550 }   # metadata, task/property chips, badges
  sm:  { size: 14px, line: 20px, track: -0.005em,  weight: 500 }   # UI default — nav, buttons, inputs, menus, tag chips
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
  btn-danger:  { background: transparent, text: "{danger}", hover: "{danger-soft}" }
  icon-btn:    { size: 24px, radius: "{r-2}", glyph: "{ink-3}", hover: "{surface-2} + {ink}" }
  input:       { height: 32px, radius: "{r-2}", background: "{canvas}", ring: "{e1}", focus: "{surface-2} fill + {e1} — see § Interaction States" }
  menu-select: { height: 32px, radius: "{r-2}", trigger: "{input}", menu: "{overlay} — the same menu a bullet opens", open: "{surface-2} fill + {e1}", max-height: 320px }
  panel:       { background: "{surface-1}", radius: "{r-3}", border: none, padding: "{sp-4}" }
  overlay:     { background: "{overlay}", radius: "{r-3}", elevation: "{e2}", layer: "{layers.menu}" }
  dialog:      { background: "{overlay}", radius: "{r-4}", elevation: "{e3}", layer: "{layers.dialog}" }
  palette:     { width: 640px, top: 12vh, radius: "{r-4}", elevation: "{e3}", layer: "{layers.palette}" }
  menu-item:   { height: 30px, radius: "{r-2}", typography: "{sm}", highlight: "{surface-2} + 2px {accent} rule at the left edge", shortcut: "{kbd} plain" }
  chip:        { height: 22px, padding: "0 {sp-2}", radius: "{r-2}", background: transparent, ring: "{e1} — {line-strong} + {surface-2} fill on hover", text: "{ink-2}", typography: "{xs}", role: "control — opens the picker on its key" }
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
  sync-slot:   { synced: "nothing", pending: "5px {ink-3} dot + count after 600ms", paused-or-error: "5px {danger} dot + reason" }
  live-slot:   { live: "nothing", connecting-or-offline: "5px {ink-3} dot + label" }
  presence:    { voice: "{xs} {ink-3}", position: "right edge of the block's line, before its tags", control: none }
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
link, caret, and structural drop, and it is the only chroma the *chrome* has. Colour
never decorates and never groups; it only names a state, and the four tones that do
(`--accent`, `--ok`, `--danger`, `--attention`) are each argued for one at a time.
Both a light and a dark mode ship from a single token declaration, because a tool you
write in at night is a tool you write in at night.

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
- One accent, ink indigo, and no second structural colour ever; four state tones, each argued
- A mono voice reserved for identifiers: property keys, graph ids
- Silence in the steady state; the interface speaks only on deviation
- Nothing below the last block is chrome

---

## Principles

1. **Structure is the ornament.** The only decorative-looking element in the product
   is the indent thread, and it is load-bearing. If a graphic device does not encode
   something true about the content, it does not ship.
2. **Luminance separates; lines do not.** Stacked surfaces differ by 3–5% lightness.
   A 1px line is legal in three places in chrome, two inside the writing, and one seam
   inside a panel (§ Depth). Every other border is a bug.
3. **No token without both modes.** A colour declared for one mode only is incomplete.
   Alpha-on-canvas ink is banned outright — it cannot be inverted.
4. **One signal per state.** Active is a fill *or* a rule *or* a weight — never all
   three. Focus is component-owned luminance, caret, glyph, thread, or selection;
   a global browser-style outline is never added on top.
   The one place a second signal is *required* rather than banned is colour: a state
   may be tinted only where a shape, a label, or a word already says the same thing,
   so nothing in the product is ever colour-only (§ The state palette).
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
| `--danger` | Destructive verbs, the unsaved state, and the last step of a state set. Never a fill behind body text. |
| `--ok` | Affirmative indicators: persistent storage granted, a task done. A mark or a mark's own fill. |
| `--attention` | "Underway, and it needs you" — the middle step of a state set, and nothing else. |
| `--on-tone` | What is drawn *on* a state tone: the tick cut out of a completed task's disc. Aliases `--on-accent`. |
| `--tone` | Not a colour — the tone a **preference** named, resolved by § The tone map. |

There is no second structural accent, and no decorative palette. If a future feature
needs to distinguish **categories**, it distinguishes them by shape, position, or
label — colour is for states, which are closed and ordered, not for categories, which
are neither.

### The state palette

Task status and priority are closed, ordered enumerations, and that is the whole
licence: with four statuses and three priorities there is a tone per step and no risk
of a palette growing to meet a taxonomy. Each set is an alias layer, so the tones stay
the ones already declared per mode:

| Step | Token | Resolves to |
|---|---|---|
| `todo` | `--status-todo` | `currentColor` — it declines a tone |
| `low` | `--priority-low` | `--ink-3` |
| `doing`, `medium` | `--status-doing`, `--priority-medium` | `--attention` |
| `done` | `--status-done` | `--ok` |
| `cancelled`, `high` | `--status-cancelled`, `--priority-high` | `--danger` |

Five rules hold this in place, and they are what make it safe rather than decorative.

1. **The shape says it first.** The tone rides a glyph that already distinguishes the
   state on its own — an empty ring, a half-filled one, a check, a cross; one, two or
   three filled bars — and that glyph always sits beside a label or inside an
   accessible name. Nothing in the set is legible *only* in colour, so greyscale,
   monochrome printing and every form of colour blindness lose the second reading and
   keep the first. This is the § Accessibility Contract's rule, not an exception to it.
2. **The unstarted step declines a tone.** `todo` takes the ink around it, which is how
   an unstarted task keeps answering hover and focus the way every other glyph does — and
   how "nothing has happened yet" stays quiet rather than being announced in a colour of
   its own (§ Principles, *silent when steady*). `low` is the same claim one step along:
   it takes `--ink-3`, the metadata ink, because "this one least" is a fact about
   ranking and not an alarm.
3. **A state tone may fill its own mark and tint its own chip. It may not fill anything
   larger.** The line it stops at is *the thing the state is about*: the 20px disc a
   status is drawn in, the 24px square a priority is drawn in, the 22px chip a moment is
   written in. Never a row, never a panel, never a band behind the writing, and never
   text at body size. The earlier form of this rule said "a glyph, at glyph size, and
   stops there", and it was one clause too strict in one direction and too loose in the
   other: an outlined tick was the quietest mark on a row that a person scans a page
   *for*, while nothing stopped a tone from tinting a whole line. This states the
   boundary as a size instead of as a medium.
4. **A settled state inverts.** `done` and `cancelled` fill the disc with the tone and
   cut the mark out of it in `--on-tone`. It is the one place in the product where a
   glyph carries two colours, and it is earned: a finished task is what a reader sweeps
   a page looking for, and a filled disc is as distinct in shape from an empty ring as a
   ticked one was — so the weight is bought without spending the non-colour reading.
   `--on-tone` is white in light mode, which is the mark a checked box has always
   carried, and near-black in dark mode, where every tone in this palette is the light
   half of its pair.
5. **A key's mark is not a value.** The glyph that stands beside `Priority` in the
   picker is the property's mark, so it opts out (`data-plain`); a red glyph next to
   the word would name a priority the property does not have.

`--attention` is a **glyph tone**, held to the 3:1 non-text bar and never used for
text — the same constraint that governs `--ink-3`. It is the neutrals' own warm hue
(75 light / 78 dark) taken to chroma, which is why it reads as this palette rather
than as a borrowed traffic light.

### The tone map

Two things in this interface are the reader's colour to choose: the outline's indent
thread, and how far off a date has to be before its chip says so (§ Settings). Neither
choice is allowed to name a colour.

A preference stores the **name of a step** — `neutral`, `accent`, `ok`, `attention`,
`danger` — and the surface carries that name as `data-palette`. Five rules in `app.css`
are the only place a name becomes a colour:

```css
[data-palette="accent"] { --tone: var(--accent); }
```

Everything downstream reads `var(--tone)`. That is what makes a user preference safe:
it cannot reach outside the committed palette, both modes come free because the tones
are already declared per mode, and every figure in § Contrast still holds for every
choice — because there are five choices and they are all in the table.

Two consequences worth stating, because both were bugs first:

- **A token derived from `--tone` must be declared on the element that carries
  `data-palette`, not on `:root`.** A custom property is substituted where it is
  *declared*; a thread colour written at the root bakes in the root's tone and no
  preference can reach it afterwards.
- **A preference tints one thing, not every thing that shares its token.** The outline's
  thread and the hairline inside a panel used to be the same token. They are now
  `--thread-line` (the outline's, tone-driven) and `--thread` (the hairline, ink-driven),
  because a reader who asked for a green outline did not ask for green table seams.

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
| `--ok` | 5.67 | 5.43 | 5.17 | 4.98 | 4.62 |
| `--attention` | 5.05 | 4.84 | 4.61 | **4.43** | **4.11** |

**Dark**

| | rail | canvas | surface-1 | overlay | surface-2 | surface-3 |
|---|---|---|---|---|---|---|
| `--ink` | 16.11 | 15.43 | 14.58 | 14.26 | 13.02 | 11.49 |
| `--ink-2` | 8.58 | 8.22 | 7.77 | 7.59 | 6.94 | 6.12 |
| `--ink-3` | 5.54 | 5.31 | 5.02 | 4.91 | **4.48** | **3.95** |
| `--accent` | 9.03 | 8.65 | 8.17 | 7.99 | 7.30 | 6.44 |
| `--danger` | 7.44 | 7.13 | 6.74 | 6.59 | 6.02 | 5.31 |
| `--ok` | 9.70 | 9.29 | 8.78 | 8.58 | 7.84 | 6.92 |
| `--attention` | 10.28 | 9.85 | 9.30 | 9.10 | 8.31 | 7.33 |

`--on-accent` on `--accent`: 6.22 light / 8.92 dark. On `--danger`: 6.55 / 7.35.

**Tinted by a tone** (§ The state palette, rule 3). A moment's chip fills with its tone
at 12% over the canvas — 20% under the pointer — and writes its label in
`color-mix(in oklab, var(--tone) 70%, var(--ink))`. Taking the tone neat would have put
amber at 3.6:1 behind 12px text; pulling each tone 30% toward the ink keeps the hue and
clears AA on both fills:

| Tone | label / chip | label / hover |
|---|---|---|
| `neutral` (`--ink-2`) | 7.98 / 8.33 | 7.03 / 7.07 |
| `accent` | 7.06 / 8.65 | 6.25 / 7.30 |
| `ok` | 6.69 / 8.94 | 5.95 / 7.48 |
| `attention` | 6.24 / 9.22 | 5.58 / 7.65 |
| `danger` | 7.27 / 7.77 | 6.39 / 6.71 |

**On a filled mark** (rule 4). `--on-tone` on `--ok`: 5.67 light / 9.58 dark. On
`--danger`: 6.55 / 7.35. Both clear AA for text, well past the 3:1 a mark is held to.

> **The one hard rule.** `--ink-3` is legal on `--canvas`, `--surface-1`, `--rail`, and
> `--overlay` only. On `--surface-2` or `--surface-3` it fails AA, so any 12–14px text
> sitting on a chip, a shortcut badge, a shortcut key, or an active nav row uses
> `--ink-2`. Text at 24px+, or 19px+ at weight 600, may use `--ink-3` anywhere.
>
> `--attention` is bound by the same rule and one more: it is a **glyph** tone. Every
> figure above clears the 3:1 non-text bar on every surface, which is the bar a 16px
> glyph is held to; the two bold figures are below AA for body text, so it never carries
> any.

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

### The heading steps, inside a block

A Markdown heading is the one place the user writes at a size the five roles do not
name, and it needs a scale of its own because it is *inside* a document rather than
labelling one. Four steps, anchored at both ends rather than picked in the middle:

| Level | Size / Line | Token |
|---|---|---|
| `#` | 28 / 36 | `--head-1` |
| `##` | 24 / 32 | `--head-2` |
| `###` | 20 / 28 | `--head-3` |
| `####` and below | 16 / 26 | `md` |

The top step sits just under the 33px page `<h1>`, so a heading is the largest thing in
the writing and still never ties with the name of the page it is written on. The bottom
step is the body size exactly, so `####` is a bold line rather than a size nobody asked
for. The two between are the interpolation. `#####` and `######` repeat the body size in
`--ink-2` — "a heading, quieter" — because the outline's own depth is where deeper
hierarchy belongs.

Three steps was the earlier answer and it was one short at the top: `#` came out at 19px
against a 16px paragraph, and a page of notes read as one undifferentiated weight.

### The mono voice

`ui-monospace, SFMono-Regular, "SF Mono", Menlo, …` at 12px/550 is reserved for things
that are *identifiers rather than prose*: property keys (`builtin.task-status`), graph ids, and
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
palette groups, shortcut sections, and property sections. None of them is allowed to
invent its own.

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
│  Tags      │        │                                │             │
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
| 1 — Ringed | `--e1` (inset 1px `--line`) | Inputs, chips, the resting edge of a form control |
| 2 — Floating | `--e2` | Menus, popovers, the page-info popover |
| 3 — Modal | `--e3` | Dialogs, the command palette |

In light mode a floating surface is white with a shadow; in dark mode it is *lighter*
than the canvas. That inversion is the whole reason elevation is expressed as tokens
rather than as a fixed shadow.

### The legal lines

A 1px line may exist in **chrome** in exactly three places, and each is the thread
language:

1. The rail's right edge — **in light mode only.** In dark mode the luminance step
   separates, and a line would read as a drawn box.
2. The command palette's input/results divider — and only while results exist.
3. `--line-strong` as an inset ring on an overlay floating over content, where a
   shadow alone cannot resolve the edge.

A line may also exist **inside the writing**, where it is content rather than chrome and
separates content from content:

4. A Markdown thematic break: 1px `--line` across the measure.
5. A rule under a `#` or `##` heading, in the same hairline. It stops at the top two
   levels on purpose — a rule under every heading is a page of rules, and at that point
   the line is the texture rather than the structure.

And once **inside a panel**, as the seam between the two halves of one field: the day and
the time of day of a single moment (§ Tasks) are one answer in two controls, and the
hairline is what says so.

Every other border in the product is deleted: no bordered cards, no bordered status
pills, and — emphatically — no dashed empty states. A chip is not a card: it is a
control (it opens the picker on its key), so it wears the control's resting ring, not a
drawn box — `--e1-chip` at 1.5px of `--line-strong` rather than the 1px `--e1` a full-size
input takes. A 22px control carrying 12px text is the smallest thing in the product and
was wearing the thinnest line in it, which made a strip of metadata read as loose words
instead of a row of things you can press.

### The one scrollbar

A scroll container is a surface with more to say, not a widget. The platform scrollbar
arrived as a grey chrome bar with a filled track and a square thumb — the last piece of
foreign UI in an interface that draws nothing else it did not choose — so the product
declares its own, **once, globally, in `app.css`'s base layer**, and no component ever
declares another. It is the same bar in the outline, in a menu, in a dialog, in a result
table and on the page itself.

- Thin, no track, and a thumb at 20% `--ink` that goes to 34% under the pointer.
  Ink-relative, so both modes come from the one declaration.
- Two declarations, one appearance: `scrollbar-width` / `scrollbar-color` for engines
  that have the standard properties, and the `::-webkit-scrollbar-*` pseudo-elements —
  which those engines ignore when the standard properties are set — for the ones that
  do not. The pseudo-element path spends its extra fidelity on a rounded thumb inset
  from the gutter by a transparent border.
- `color-scheme: light dark` on the root stays, because it is what makes the *native*
  scrollbars this product does not own — inside a `<select>`, a date picker — follow
  the theme anyway.
- A component may still choose `scrollbar-gutter: stable both-edges` (the outline
  viewport does) to stop a scrollbar's arrival from shifting the text under the caret.
  Reserving space is a layout decision; painting the bar is not the component's.

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
panel. Focus treatment stays inside the component's existing shape; no global offset
outline gets a second silhouette. v1's global `:focus-visible { border-radius: 4px }`
squared off every rounded control in the product the moment it was focused, because
`app.css` was imported unlayered and therefore outranked every Tailwind utility.

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
> animating it is what *prevents* a moving target rather than what creates one. When a
> dialog swaps between bodies of different lengths, it must not re-centre and move a
> control away from a pointer already travelling toward it. When `⌘\` collapsed the rail, the entire
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

`prefers-reduced-motion: reduce` collapses animation and transition durations to
1ms, so a reduced-motion user gets no motion rather than an instant snap. It
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
- **A glyph may be tinted, but only where its shape already says the same thing.** The
  status and priority marks are the case, and the rules that keep it honest are in
  § The state palette. Outside that closed set, glyphs rest at `--ink-3`.
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
| Focus (controls) | Component-owned luminance, glyph, thread, or selection treatment; native outlines are suppressed globally |
| Focus (fields) | `--surface-2` plus the resting `--e1` edge; borderless writing surfaces use their caret or active thread |
| Pressed | `--surface-3` (or `--accent-hover` for the primary action). No transform. |
| Disabled | 50% opacity, pointer events off, still in the layout, still announced, and in the palette still listed **with its reason** |

> **Why focus has no global ring.** Indigo names an action, a caret, or a structural drop.
> Reusing it on every field made ordinary navigation read as a succession of actions and
> put a blue frame around controls opened with the pointer. A neutral offset outline was
> still a foreign frame around otherwise borderless UI. Fields now change luminance while
> keeping their resting edge; other controls reveal focus through their own existing state.
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
state; there is now one token, and the highlight is one shape everywhere: the
`--surface-2` wash plus a 2px `--accent` rule at the row's left edge. Every option list
is also keyboard-reachable — `↑`/`↓` move the single highlight, `Enter` chooses,
`Escape` leaves — whether the list stands behind an input (the palette, the property
search, the date editor) or is the surface itself (the type chooser, an enum's values).
The chosen value in a list is never marked by a second wash; it says so with its check
mark. Finally, everything pressable invites the press: `cursor: pointer` is declared
once, globally, for buttons and option rows — never per control, which is how
individual buttons kept shipping without it.

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
| `Tags` | Rail | The graph's tag index, and the one place a tag's defaults are edited |
| Page list + `＋` | Rail | Navigation, and the only pointer route to a new page |
| `Settings` | Rail footer | Workspace-level, deliberately away from daily use |
| Save slot | Top bar | **Renders nothing when saved.** Present only on deviation |
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

Date stepper and calendar trigger · collapse chevron · a tag chip's remove state (the
`#` swaps to `×`) · a tag card's delete · graph card `⋯` ·
the rail's `⌘K` badge · the append zone's faint bullet · a shortcut row's reset ·
a query block's view menu and its `⋯`. Every
one of these is also in the palette or in Settings, pinned visible at or below 600px, and
revealed on `:focus-within` — and revealed with `opacity`, never `display` or
`visibility`, so keyboard and automation can always reach it.

> A query block's two menus are the one entry on this list whose object is not already a
> permanent control. What makes them honest is that the block's own caption *is* one: the
> sentence naming the query is permanently visible, permanently pressable, and opens the
> editor — so the only thing revealing hides is *layout* and the overflow, and never the
> route to the query itself. An open menu keeps its trigger showing, so the pointer may
> leave the block without the control it opened disappearing under the menu.

### Summoned only

The command palette · the shortcut sheet · Settings · a block's menu (right-click its
bullet, or `⇧F10` from its text) · the page's menu (right-click its title row) · page
the property picker · the tag picker · tagged-block defaults · page info · every
confirm dialog.

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
- System property rows (`builtin.page-kind`, `builtin.journal-date`, `builtin.created-at`) from the
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
- The query block's permanent toolbar. Its mode word became the caption, its view name
  became the icon the answer below it already makes obvious, its second `⋯`-shaped menu
  merged into the first, its Run button became a menu row for a thing that reruns by
  itself, and its `revision 16` became a `⋯` label and an attribute. What is left is a
  sentence and a count.
- The builder's `Every one of them — add a condition to narrow it down.` hint, and the
  line break inside `Find blocks / all of the following`.
- The `No results` paragraph under an empty result. The header's count is the empty state;
  the paragraph was the same fact 34px lower.

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
5. **No first-run hint.** The rail's permanent `Search` row and its `⌘K` badge teach
   discovery without placing instructions inside the writing surface.

---

## Components

### The outline

**Row.** 28px at one line: 16px/26px text with 1px of vertical padding, making a screen
of short lines read as a list rather than a column of paragraphs. It was 30px, and at
that height the gap between two siblings competed with the gap between a block and its
own metadata strip — depth, not air, is what should be doing the separating here.
**One indent is 30px**, up from 24px: at three levels the difference between two siblings
and a parent and its child was six pixels of text offset and one hairline, and § Measure's
848px still leaves a block five levels deep 698px to write in.
`padding-left: calc(var(--gutter) + var(--depth) * var(--indent))`
from CSS custom properties, not an inline style that silently overrides the row's own
padding shorthand, and a matching negative `margin-left` so the row reaches one gutter
further left than its text: that strip is the selection gutter. `cursor: text` across the
text, `default` over the gutter. **No hover fill and no focused-row fill** — the caret is
the signal, and a full-width wash behind the line the user is typing is noise. A
*selected* row is the one exception, and § Selection says why.

**Thread.** Three `linear-gradient`s on the row background. Zero extra DOM, because the
rows are virtualized — a pseudo-element the row does not have and a `<div>` per level
are both worse than one more background layer.

Two of them draw the **ancestor columns**: one `repeating-linear-gradient` offset by half
the bullet slot and sized to `depth × indent` at rest, and the same gradient in the active
tone sized to the `--lit` levels. Ancestors of the focused row carry
`data-ancestor="true"`, which lights the path from the root to the caret continuously even
across intervening siblings.

The third is the **bullet's own thread**, and it is what makes this a tree rather than a
set of indents. It runs from just under the bullet of a row that has children to that
row's bottom edge — which is exactly the gap between a parent's mark and where its first
child's ancestor column begins. Without it the vertical line under a bullet appeared out
of nowhere one row later, and a parent with a two-line body had a visible break in the
middle of its own subtree. A **collapsed** row is the one case that has children and
draws nothing: the halo on its bullet already says they are there, and a line to nothing
is a promise the next row breaks.

**The thread is the one colour in the product the reader chooses** (§ The tone map,
§ Settings). At 8% of ink the resting line was a rumour — present in a screenshot and
absent on a screen, which is how the one piece of structure an outliner draws for free
came to be asked for as a feature. It is now 30% of the chosen tone at rest and 72% on
the lit path, still quieter than `--line`, and it is `--thread-line` rather than
`--thread`: the hairline inside a panel keeps its ink-relative value, because a reader
who asked for a green outline did not ask for green table seams.

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

**Enter preserves the block, not merely its text.** At the first caret position it
creates a blank line before the current block, leaving that block's identity,
properties, tags, and children together as they move down. In the middle, the
current block keeps the head and metadata while a new block receives the tail; at
the end, a blank block follows. One press is one document undo item in every case.

With more than one block selected the menu changes subject: `Indent`, `Outdent`, and
`Delete N blocks`. It is the same menu on the same object, answering for the selection
that object belongs to.

**Tags.** Gathered at the right edge of the block's own line, only when present: the
writing keeps at least 60% of the measure, and when both cannot fit the cluster wraps
under the text, still right-aligned. A chip is bare text — no fill, no drawn box, no
reserved remove slot: `--ink-2` at 12px with the `#` at 55% opacity, still inside
`textContent`. The whole chip is one button whose only verb is removal, and it says so
in place — hover or focus swaps the `#` for a `--danger` `×` inside the same glyph
column, so nothing shifts and no space waits empty. A deleted target is `line-through`
**and** says so in its accessible name — never colour alone.

**`#` at the caret is the tag menu** — the slash menu's twin: the same
whitespace-delimited token scan, the same row language and keys, tags instead of verbs.
It attaches *existing* tags only — bringing a tag into existence is the tags screen's
verb — so a query nothing matches simply closes the menu and the token stays ordinary
text. Accepting removes the token and writes structural membership, never text; a tag
the block already carries says so with its check mark, and choosing it only removes
the token.

**The tags screen** (the rail's `Tags` row) owns the tag lifecycle. One `--surface-1`
card per tag — the name in the tag's own `#` voice, its *defaults* (the values copied
onto a block when the tag is added) in the outline's chip language, each chip opening
the same contextual property picker. Deletion is a hover-revealed trash control on the
card behind a confirm dialog. The create card is the one ringed card in the grid,
because it is a control, not content: pressed, it becomes an inline name field — `⏎`
creates and stays for the next name, `Esc` or leaving closes it.

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

### Markdown blocks

A block with Markdown syntax reads as formatted content while it is not being edited and
returns to its exact source in the outline's textarea when its body is pressed. Links are
the exception: they follow their destination rather than opening the editor. The focused
block remains source, so the accent caret, IME boundary, slash and tag menus, Enter split,
and document undo keep one owner. Plain text is permitted to remain on the textarea fast
path because formatting it would produce the same pixels and words.

**The projection is a reading of the block, not a different block.** Three rules follow
from that, and each of them was a defect before it was a rule.

1. **A press opens the editor at the word that was pressed.** Landing the caret at the end
   of the source instead is the difference between a document you can correct and one you
   have to navigate: the reader pressed a typo, not a block. The rendered text and its
   source are the same characters in the same order with syntax interleaved, so the offset
   is recovered by walking the two together — no stored positions, no second parse.
2. **A drag is the outline's, not the projection's.** Dragging quiet writing surface
   already means a text selection, or the block range selection that crossing a row
   starts. Answering the same gesture by opening an editor would undo whichever one the
   reader was making, so the projection acts only on a press that did not travel.
3. **The projection carries the row's tab stop.** It stands in for the textarea, and the
   textarea is the row's one way in for the keyboard. Focus reached by keyboard hands
   straight over to the source; focus reached by pointer waits for the press, which knows
   where the caret goes. A page of rendered blocks is otherwise a page with no way in.

Markdown inherits the block's 16/26 body voice. **Six heading levels get four steps** —
28 / 24 / 20 / 16, anchored under the page title at the top and on the body size at the
bottom, with `#####` and `######` repeating the last step in `--ink-2`. § The heading
steps has the table and the argument. **`#` and `##` also carry a hairline rule beneath
them**, because those two open a *section* and a section opens with a line; § The legal
lines admits it as a line inside the writing and says why it stops there.

A list gets its markers back, at `--ink-3`: a marker is structure rather than writing, and
a list with no marker is a paragraph. Inline code and fenced code share the mono voice on
`--surface-2` — one tint, not two, because `--surface-1` against the outline's `--canvas`
is a 1.5% step and the depth scale asks for 3–5%; the shape already says which is which,
and a drawn border is not available to say it. A quote borrows one inset rule and `--ink-2`
text. A thematic break is a 1px `--line` across the measure: a break *inside* the writing,
which is the one horizontal rule this product draws. A table borrows the query result
table exactly — a `--surface-2` header band, no row lines, and sideways scrolling of its
own so a wide table never widens the measure. Links use the one accent and an underline. No
imported prose theme, syntax-highlighting palette, bordered callout, or Markdown-specific
card is allowed.

A newline inside a block is a line the author broke, so it renders as a line break. Prose
reflow is a convention for source files that hard-wrap paragraphs, and it is the opposite
of what a block editor does: collapsing those lines would make the reading disagree with
the editor directly above it, and re-wrap the row on every focus change.

Raw HTML never becomes interface. An image becomes its alternative text instead of a
network request, preserving the local graph's privacy boundary and the outline's measured
width. A Markdown checkbox is inert text: the row's own status glyph stays the only mark
in this product that means a task. Query results use the same parser and safety policy in
a compact inline reading; their cell remains the single edit/open control, so rendered
Markdown never nests an interactive link, a second line, or a table box inside it.

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

44px. `<h1>` at 33px/600, so the page's name reads as the largest thing on the surface
rather than merely the boldest. On the right: a hover-revealed
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

- `/` in a block opens the slash menu (below). Its indirect items — `Scheduled`,
  `Deadline`, `Add property` — remove the slash token, persist a pending block if
  necessary, and open the picker for that block, already on their key when they have one.
  Its `Query …` items are not picker routes: they build a query in place (§ Query block).
- `⌘P` opens it for the focused block, or the page when no block is focused. The title
  and bullet context menus provide the pointer routes, and the palette's task rows
  (`Set task status…`, `Set priority…`, `Set scheduled date…`, `Set deadline…`) open the
  same picker on the named key.
- The first stage searches existing and registry keys and can create a validated custom
  key. Every candidate row leads with its value-type glyph, so a key reads as its kind
  before its name. A custom key adds a type stage; the value stage is derived from that
  type.
- Existing rows enter directly at the value stage. Repeated values stay individually
  removable, while Clear removes the whole property.
- A suggested-string key renders its choices as glyph-led rows — task status and
  priority use their own shape glyphs, tinted (§ Tasks) — and a stored value outside the
  suggested set stays listed, so opening the editor can never silently rewrite it. The
  glyph beside a *key*'s name in the first stage is the property's own mark and stays
  untinted (§ The state palette, rule 4).
- A date value is one field that reads words. The same parser behind the palette's date
  rows resolves `tomorrow`, `aug 15`, `2026-08-15`, `다음 월요일` into a pressable
  preview row; an empty query offers `Today`, `Tomorrow`, `Next week`; and the
  platform's own date input stays at the bottom as the precision tool, per
  § Implementation's "native where native is better". Choosing any of them commits —
  a date editor has no separate Set button.
- **A task date grows one row rather than a second surface to visit.** Under the day sits
  the time of day — the platform's own clock, for the same reason the date row keeps a
  native picker — separated by the one hairline § The legal lines allows inside a panel.
  It writes as soon as it is complete and **does not close the panel**: a time is a
  refinement of the answer the picker was opened for, not the answer, and closing on one
  would throw the reader out halfway through describing one moment. Clearing it returns
  the moment to the whole day.
- **A recurrence is a count, a unit, and the words they make.** The preview reads the
  interval back in a sentence, because a choice confirmed by reading beats one assembled
  from a number field and a unit noun in two separate controls.
- System keys are omitted and live in page info. Tags keep a separate picker because
  membership and property values are different domain commands. The query key is
  omitted too, on entities and on tag defaults alike: its own block is the whole
  editor, and that block's menu is where it is removed.

The picker is portaled and fixed to its invoking row or editor, so it does not resize the
outline or get clipped by virtualization. `Escape` closes without changing slash text;
a successful command closes and restores focus to the invoking document control.

**A surface the picker opened is not "outside" it.** Both the entity autocomplete and the
one dropdown portal to the body, so a press on one of their rows lands outside the panel
in the DOM while being, to the reader, a press inside the editor they are filling in.
Dismissal exempts them; § Overlays carries the matching z-order.

### The slash menu

`/` at the caret opens the editor's own command surface, and it borrows the palette's
row language — one highlight shared by pointer and keyboard, a 2px accent rule on the
active row, § The group label for its dividers — at the caret instead of at 12vh.

- **Grouped when browsing, ranked when searching.** An empty query shows every item
  under `Task status` / `Priority` / `Date` / `Query` / `Property` labels; typing filters
  across all groups with the palette's own fuzzy matcher and English and Korean aliases,
  and a ranked list is deliberately not re-grouped.
- **Direct items write in one keystroke.** A status or priority row removes the token
  and issues one `set_property` — no picker, no intermediate surface. Indirect items
  (`Scheduled…`, `Deadline…`, `Add property…`) open the picker instead.
- **`Query blocks` / `Query pages` / `Query tags` turn the line into a query** and open
  the builder on a plan that already runs. This is the *only* route to a query: the
  property picker does not offer it, because a query is built, not filled in.
- `⏎` and `⇥` take the highlighted item, `↑`/`↓` move it, `Escape` closes without
  touching the draft, and the whole surface stands down during IME composition.
- On a pending block the choice waits for the real block id — a temp id never crosses
  into a command or the picker.

### Tasks

A task is any block whose bag carries a `builtin.task-*` key; there is no task storage
shape. The presentation is positioned, not generic — the four keys never appear as
generic property rows on a block, because they would state the same facts twice. Every
positioned control still routes to the same picker.

- **Status and priority are the two marks before the writing** — status first, in the
  position a checkbox has held in every list tool, then priority, then the words. They
  answer the same question the sentence does and they answer it earlier, which is why
  priority left the chip strip: under the text it was read *after* the line it was
  supposed to qualify, and it competed with a row of properties for the attention it
  needed first. The pair sits in the text's hanging indent, so a wrapped line keeps one
  left edge and a row acquiring a priority never reflows its sentence.
- **One circle language carries the status set**: empty (`todo`), half-filled (`doing`),
  a filled disc with a tick cut out of it (`done`), the same disc with a cross
  (`cancelled`), dashed for a value outside the suggested four. **Shape first, then
  colour**: each step also takes its tone from § The state palette, and the shape alone
  still carries the state, so the tint is the second reading and never the only one.
  Clicking either mark opens the one dropdown (§ Choice) with `menuitemradio` rows and an
  explicit removal item.
- **Priority is one to three filled bars on a wash of its own tone.** Three 3px bars is a
  small mark to hang a distinction on, and beside a filled status disc it lost every
  time; the wash gives it comparable weight without inventing a second shape. The count
  of filled bars is still the first reading and the label is still in the accessible name.
- **Done and cancelled are settled**: the block's text strikes through and steps back
  one ink level. The glyph, its tone, and the strike agree; none of the three is the
  only signal.
- **A priority list is offered strongest first.** The registry states its suggested
  values in the domain's ascending order, which is the right order to store and the
  wrong order to read: the reason a person opens a priority list is to *raise*
  something, so `High` is the row nearest the pointer. Status keeps the registry's
  progression, because that is the order the work moves in.

**A moment is a day and, optionally, a time of day.** Scheduled and deadline are quiet
chips under the text, in the chip metrics, each led by its glyph and each a pointer route
into the picker on its own key. The day is written in the user's own journal date format;
a time follows it in tabular figures, in the locale's own clock. A date with no time means
the whole of its day, which is what it has always meant. The two are stored as separate
keys and read as one fact — the day stays a `date` so it remains comparable in the query
index, and the time refines it.

- **A missed moment says so in words.** When it has passed and the status is not settled,
  the chip carries the word `Overdue` — a deviation is plain, never colour-only, and it
  falls silent the moment the task settles.
- **How far off it is, it says in colour.** Four ordered steps — `overdue`, `soon`,
  `upcoming`, `later` — tint the chip through § The state palette's rule 3. Both the day
  thresholds and the tone each step takes belong to the reader (§ Settings): "soon" is a
  week for someone planning a quarter and an hour for someone shipping today, and which
  tone means *act now* is a habit people bring with them. What is not theirs is the
  shape — four steps, `overdue` first — because the ordering is what makes the tint
  readable at all. The date and the word are still written out, so the tint is the
  second reading here too.
- **A settled task has no urgency left to report.** The strike through its line is the
  whole reading; a red date on a finished job is noise.

**Recurrence: `Done` means "this one", not "all of them".** A task with a repeat interval
is offered `Complete this one` in place of `Done`, and choosing it keeps the status at
`todo` and moves the moment on by the interval — counted from the date that was set, not
from today, so a weekly task finished three days late is still due on its own weekday. A
toast says where it went, because the only visible consequence is a date the reader may
not be looking at. The interval is a count and a unit (`1d`, `2w`, `3m`, `1y`) and it has
its own chip; the grammar stops there deliberately — a cron field or an RRULE is a
calendar's job, not an outliner's.

### Query block

A query is a tool embedded in the outline, not a dashboard card. Its quiet
`--surface-1` frame follows the block's width; the editor — builder or source — is a
full-width band on `--surface-2`, and results begin immediately below it.

> **The answer is the block; the question is a disclosure.** v1 stated six things in a
> toolbar (a mode word, the view's name, a sliders icon, the index revision, Run, `⋯`)
> above five permanent rows of builder — on a journal page, ~500px of authoring chrome
> over a six-row answer, every time the page opened, whether or not anyone was authoring.
> A query is read far more often than it is written, so the block now rests as **one
> caption line and its result**, and everything about *writing* it is behind the caption.

- The header is one line: **the plan read back as a phrase**, then how much it found,
  then — revealed — the view menu and the block's `⋯`. Nothing else.
- **The sentence is the disclosure.** `Blocks · Status is Done` is both what the query
  says and the control that opens the editor that wrote it, with a chevron and
  `aria-expanded`. That is what licenses revealing the two menus: the phrase is a
  permanent, labelled pointer route in, so the block needs no `Edit` button beside it.
  The caption follows the *draft* plan, so it is already true when the editor closes.
- The caption is a summary, not a transcript: two conditions per level, then `+N more`;
  a nested group keeps its parentheses, because `or` inside `and` is the one thing a
  flattened list would misreport. A hand-written query's caption is `SPARQL`. Because the
  middot is drawn in CSS, the disclosure states its accessible name rather than letting
  two adjacent spans compute one.
- **The editor opens for a query nobody has written yet, and stays shut for one that has
  been.** A plan with no conditions has nothing to caption and a blank source has nothing
  to answer, so `/` lands on the builder; a shaped query reopens on the answer it was
  shaped for. Which it is becomes the reader's from their first press, and never
  re-derives under their hands. It is local state — never saved view data.
- **The count is the empty state.** `No results` / `1 result` / `6 results` in the header,
  in tabular figures, and no second sentence below saying it again. On the first run it
  reads `running`; a rerun afterwards updates the number in place rather than flickering
  `running` over it on every debounced keystroke.
- **The revision is a diagnostic, not a fact about the answer.** It is a quiet label at
  the foot of `⋯` and a `data-revision` attribute — never a permanent word in the header.
  Run lives in `⋯` too: the block reruns on every edit and every canonical revision, so a
  permanent Run button was a verb for a thing that already happens.
- **One menu for layout.** Table-or-list, which columns show, and how tall the rows are
  answer one question — how this answer is laid out — so they are one icon-only dropdown
  with group labels, not two triggers for two halves of it. Its icon is the state it
  carries. A column's shown/hidden state is two glyphs (`eye` / `eye-off`), because state
  carried by a single glyph with a dead attribute is state nobody can see.
- Table and List are presentation modes over the same result. Changing one persists
  the query document's shared default view; it never reruns or rewrites the query.
- Results, loading, errors, and selection are not saved view data. Switching views
  changes only the existing result's presentation. Column **order, width, visibility and
  sort** *are* saved view data, because a reader who shapes a table means it to stay
  shaped — a sort that evaporates on reload is a sort the reader has to re-apply every
  time they open the page, which is the same defect as a width that forgets itself. Sort
  is still presentation: it reorders the rows the query already returned, while the
  query's own ordering — the one a `LIMIT` cuts against — lives in the builder's Sort
  row. On a read-only graph a header click still sorts; there is simply nowhere to write
  the choice, so it lasts as long as the block is mounted.
- **An answer is shown in full.** The result never caps its own height and never scrolls
  its own rows: the document scrolls, as it does for everything else on the page. A
  second scrollbar inside a surface that already scrolls hides how much the query found
  and makes the reader discover the rest.
- At narrow widths the editor and result keep the outline width. The table scrolls
  **sideways** and only sideways; builder rows and list values wrap. The header stays one
  row: the caption's qualifier truncates first, and the count and both menus keep their
  places — the menus are pinned visible at or below 600px, where no pointer reveals them.

#### The builder

The builder is the default and the only thing `/` creates, because most people who
want a query do not want a language. It reads as a **sentence in rows** — *Find blocks,
all of the following … / show … / sort by … / limit …* — where the connectives are
12px `--ink-3` words that are never controls, and every choice is the product's one
dropdown (§ Choice) at the same 32px form metric as every other field.

- **One clause is one line.** The subject and the root group's match are the same
  sentence, so they are the same row, with a wider gap where it turns. Splitting them
  put a lead word and a line break inside one clause; the root group draws no head of
  its own, and only a nested group does.
- **An empty group says nothing.** Its `Condition` button is the affordance; a sentence
  explaining that no conditions means everything was a paragraph of chrome inside a form.
- **A condition is one row**: field, comparison, value. The value editor is the one
  its field's type deserves — the shape-led rows for a task status, a relative-day
  menu (`Today`, `In 7 days`, `Start of next week`) for a date with the native picker
  behind `Exact date…`, `PageAutocomplete` for a page, removable chips for `is any of`.
- **A group is depth, not a card.** A nested `all` / `any` / `none` group is set apart
  by one indent and a single hairline in the thread language — no border, no fill
  (§ The legal lines). That nesting is what gives the builder SPARQL's reach.
- **Remove is revealed, never summoned**: the `×` on a condition and the wastebasket
  on a group appear on hover or focus of their own row and never change the layout.
- **A column is a chip whose dropdown is its summary.** Its resting option is the
  plain field; choosing `count of` or `all` renames the chip to say so, so summarizing
  is a property of the column rather than a separate mode.
- **The SPARQL is available, never in the way.** `Show SPARQL` discloses exactly what
  the builder will run, read-only in the mono voice; `Edit as SPARQL…` writes that
  query out in full and hands it over, which is a one-way door and says so by leaving
  the builder.

#### The result table

- Headings separate from the body by luminance and ink, never a rule: the header row
  is `--surface-2` in the 12px `--ink-2` voice. It does not stick, because the table has
  no vertical scrollport of its own to stick to, and a sticky header per query block on
  a page of query blocks would be a stack of floating bars.
- A heading **is** the sort control and carries no button chrome at rest, because a
  row of headings that all look like buttons reads as a toolbar. Its overflow menu
  holds sort, move, hide, and reset-width, each with a keyboard route.
- The width handle is the only vertical line in a table and it is `--thread`, so it
  reads as the seam between two columns rather than as a drawn cell border. It is a
  `separator` with a value, so `←`/`→` resize it without a pointer.
- **Dragging one column resizes one column.** Widths are declared in a `<colgroup>` on a
  fixed-layout table, so a declared width is honoured exactly rather than treated as a
  suggestion the auto algorithm may redistribute across its neighbours. A final column
  with no declared width absorbs the slack: the table still spans the block when the
  answer is narrow, and overflows it — sideways, with the product's own scrollbar — once
  the reader has widened the columns past the edge. It carries no heading and no value,
  so the count of real columns is stated with `aria-colcount` rather than counted off
  the DOM.
- Cells read as what the query asked for: a page or block cell is a route to the thing
  it names, a date is in the reader's own journal format, a task status keeps its
  shape glyph, tags are chips, and numbers align to the end of their column in tabular
  figures. A column the query did not describe falls back to `?variable` and plain
  terms — honest about knowing less.
- A direct field in a built block query is editable in place. Its resting cell is
  unchanged; hover or keyboard focus raises the standard input fill, and activation
  replaces only that value with its native text, choice, property, or tag control.
  A small hover-revealed arrow beside editable block text retains the route to the
  block's document. Aggregates, relations, and hand-written SPARQL stay plain.
- **In a table the target is the cell, not the words.** An editable cell hands its
  padding to its control and the control fills the cell, so a two-character value in a
  180px column answers a press anywhere across it — and so the raised fill reads as
  *this cell* rather than as *these words*. The route-out arrow floats over the cell's
  end on reserved padding, so the press target neither shrinks nor shifts when the
  pointer arrives.

#### The result list

Blocks answer as blocks. A list row is an **outline row**: the same bullet in the same
gutter, the same 16px line, the status shape at the head of it, and every other
selected value as the same chip strip that sits under a block in the document. It is a
lens, not a second document — direct text and facts use the same field controls as
the source block, while the bullet remains a real focus stop that opens the block
where it actually lives. Structural moves and subtree actions stay in that document.

If an edit makes a row stop matching, the row keeps the selection wash and says
`No longer matches this query` until the active editor closes. This is the one
temporary exception to the result set: it preserves the caret and makes the row's
departure causal rather than abrupt; it is never saved view data.

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

### Collaboration status and presence

A remote graph adds two slots beside the save slot, in the save slot's exact
language — the quiet 12px voice, the 5px dot, and nothing at all in the steady
state — because three adjacent slots with two dialects would read as three
different kinds of thing. `synced` and `live` render only screen-reader text.
`pending` waits the same 600ms as `saving` so an outbox that drains between two
keystrokes never flickers, and it stays silent at a count of zero, which every
reconnect briefly reports. `paused` and `error` are the deviations: `--danger`
ink, the reason as plain visible text. The sign-in that clears an auth pause
lives in the members dialog — the graph switcher's `Manage members`, which is
also a palette row, per Principle 5.

Who else is on a line is metadata, not a control. Peers' names render as bare
12px `--ink-3` text at the right edge of the block's own line — the tag
cluster's position, one ink step quieter than a tag — with no fill, no ring, no
drawn box, and no hit box of their own. Caret moves coalesce briefly before one
presence frame goes out, so following a peer never costs a frame per keystroke.

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

Two scopes, and saying which is which is the section's whole job. Appearance, language,
date presentation, keyboard bindings, and storage persistence belong to the
**browser** and apply to every graph. Graph identity and deletion belong to
**this graph** and travel with it.

- **A dialog, not a route.** Settings are an aside: you open them from wherever you are,
  change one thing, and come back to the same block with the same caret. 820px, a 168px
  scope nav on the left, the pane scrolling on the right.
- **Two named groups, each with a real `<h3>`.** `Application` — Appearance, Language,
  Journal, Tasks, Keyboard, Storage. `This graph` — Graph, Danger zone. The headings and
  § The group label's typography carry the scope distinction without explanatory copy
  inside the navigation column.
- **Switching sections fades** at `--dur-view`. The pane is a box that is already on
  screen and already the right size; without it, changing sections read as the dialog's
  contents glitching rather than as one section replacing another.
- **The open section is in the URL** (`?settings=keyboard`). The browser's own Back closes
  the dialog, a link can point at one section, and a reload comes back to it.
- **The dialog title is the largest thing on the surface**, so a section heading steps
  down to 14px/600 rather than tying with it at 19px.
- **Journal date format carries a live example per option** (`Abbreviated month — Aug 5,
  2026`). A user choosing how their days are written should be reading the result, not
  decoding a label.
- **A colour setting previews itself, at the size it will be.** The outline thread's five
  swatches are not coloured squares: each is three indent threads in the tone being
  offered, on the canvas they are drawn on, at the weight the outline draws them. The
  chosen tone's name reads at the end of the row rather than under every swatch, so the
  choice is nameable without five words of chrome. A setting whose result you cannot see
  until you close the dialog is one people change twice and then leave wrong.
- **`Tasks` is four ordered rows, each previewing itself with the real chip.** Two of them
  carry the day threshold they reach to; all four carry the tone they take. The order is
  fixed and the numbers are not, and § Tasks says why. `Restore defaults` is one button,
  because four wrong colours is one mistake.
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

**The one dropdown sits above a popover, not under it.** `--z-menu` is above
`--z-popover`, which looks backwards read as a list of kinds and is right read as an
order of opening: the two only ever coexist one way round, because every route from a
menu *to* a popover closes the menu first. A menu that a popover opened — the interval
editor's unit list inside the property picker — is therefore always the newer layer. With
the scale the other way it rendered behind the panel that summoned it and could not be
pressed at all.

**Placement is one rule, declared once.** Every surface that hangs off something on
screen — the slash menu, the tag menu, the property picker, the tag picker, the entity
autocomplete — is placed by the same function, and it never needs to know how tall the
panel is:

1. **Below the anchor is the preferred side**, because that is where the reader is
   already looking. The panel is pinned by its `top` and grows downward.
2. **When the room below cannot hold it and there is more room above, it flips** and is
   pinned by its `bottom` instead. A box anchored at the bottom grows upward on its own,
   which is what removes the measurement, the second layout pass, and the first frame in
   the wrong place.
3. **The `max-height` it is given is the room actually left on the side it chose**, so a
   long list scrolls inside itself rather than off the screen. A panel therefore never
   declares its own height cap in CSS.

> **Why this is a rule and not five implementations.** It used to be five, each with its
> own guessed panel height, and every one of them clamped the panel's *top* to
> `innerHeight − guess`. A caret near the bottom of the window therefore opened its menu
> hundreds of pixels **above itself**, over the text it was about to change. The bug was
> not in any one of the five; it was in there being five.

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

1. Contrast follows the committed table. `--ink-3` never touches `--surface-2/3`, and
   `--attention` is a glyph tone held to the 3:1 non-text bar, never used for text.
2. Focus appearance is component-owned: luminance/resting edge for fields,
   caret/thread for writing surfaces, and the control's existing glyph or selection
   treatment elsewhere. Native global outlines are disabled.
3. Real landmarks: a `<main>` in the primary view and a skip link. `aria-hidden` never
   lands on the only landmark.
4. Real headings. Every section that looks like a heading is one; no uppercase `<span>`
   doing the job, and no `aria-label` duplicating a visible heading.
5. State is never colour-only and never `title`-only. Where a state *is* tinted
   (§ The state palette) a shape, a label, or a word already carries it, so the tint is
   only ever the second reading.
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
- **One owner per token.** `app.css` owns `--r-1..4`, the colour ramp — including the
  state palette's aliases and `--scroll-thumb` — and the type scale. `globals.css` maps
  them onto shadcn's semantic variables through `@theme inline` and declares nothing of
  its own. v1 declared `--radius-sm/md/lg/xl`, `--font-sans` and `--color-primary` in
  *both* files with conflicting values.
- **One place per global.** The product's scrollbar (§ The one scrollbar) and its
  anchored-panel placement (§ Overlays) are each declared once — in `app.css`'s base
  layer and in `ui/anchored`. A component that wants either of them uses it; a component
  that reimplements either is the bug those two sections exist to close.
- **Class names are namespaced by family and never a bare utility name.** A bespoke
  class must contain a hyphen. v1's `<section className="outline">` collided with
  Tailwind's `outline` utility and drew a 1px black box around the entire outliner.
- **Radix supplies behaviour, this document supplies appearance.** Portalling, focus
  trapping, dismissal, roving focus and ARIA wiring come from the primitive; every
  visual property comes from a token. shadcn's `focus-visible:ring-2` and
  `focus-visible:border-ring` are removed, and native outlines are suppressed globally;
  focus appearance belongs to each component.
- **Native where native is better — and a `<select>` is not.** Checkboxes, date inputs and
  time inputs stay real form controls, because the platform brings a picker and a mobile
  wheel that nothing here can reproduce. A list of choices brings an unstylable popup
  instead, drawn by the OS in the OS's own language, so it became the one Radix menu every
  other choice in the product uses; § Choice argues it and names the cost.
- **Native where native is wrong — the spell checker.** `spellcheck="false"` on the root
  element, inherited by every descendant. The browser's dictionary has no entry for a page
  name, a tag, a property key or a SPARQL variable, so in a document made of short graph
  references it produced a page of red underlines that were never mistakes — and it cannot
  be right about text this product has no language for. One declaration at the root rather
  than an attribute on each of a dozen authoring surfaces, and on the next one somebody
  adds.

---

## Do / Don't

### Do

- Let the indent thread be the one graphic device, and light the path to the caret.
- Separate surfaces with a 3–5% lightness step; reach for a line only in the places
  § Depth lists.
- Declare every colour in both modes in the same block, and keep hue and chroma fixed.
- Consult the contrast table before styling text on a tinted surface.
- Reserve `--accent` for actions, links, carets, selection/drop state and the active thread.
- Tint a state only where its shape or its label already says the same thing, and only
  inside a closed, ordered set (§ The state palette).
- Hang a summoned panel off its anchor with the one placement rule, and let it flip above
  the anchor rather than clamp itself into the middle of the page.
- Declare a column's width where the layout will honour it exactly, and give the leftover
  space a column of its own instead of spreading it across the reader's columns.
- Make the whole cell the target when the whole cell is editable.
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
- Keep checkboxes, date fields and time fields native; restyle rather than rebuild — but
  turn the spell checker off, because it has no dictionary for a graph.
- Let exactly one region scroll, and let the top bar never reflow.
- Store a colour *preference* as the name of a declared tone and let CSS resolve it, so a
  choice cannot leave the palette or the contrast table (§ The tone map).
- Draw a token that depends on `--tone` on the element that carries `data-palette` — a
  custom property is substituted where it is declared, not where it is read.
- Scroll a focused row into view only when it is not already visible: a row taller than
  the window cannot be aligned without moving the page out from under the caret.
- Answer "focus left this row" on the next frame, by asking where focus went, rather than
  on the `blur` that only says it left.

### Don't

- Don't draw a border to separate two surfaces — that is what lightness is for.
- Don't ship a dashed empty state, a bordered chip, a bordered status pill, or a card
  inside a card inside a card.
- Don't introduce a second structural accent, or tint a chrome glyph. A state glyph is
  not chrome; a nav icon, a toolbar icon and a property *key*'s mark are.
- Don't tint categories. Colour names a state, and a state set has to be closed and
  ordered before it earns one.
- Don't let a state tone fill anything larger than the thing the state is about: a mark's
  own disc and its own chip, never a row, a band, or a panel.
- Don't write a colour from TypeScript, not even for a setting the user chose. Write the
  tone's *name*; § The tone map turns it into a colour.
- Don't apply one preference to two tokens that happened to share a value — a chosen
  outline tone is not a licence to tint every hairline in the product.
- Don't put `--ink-3` on `--surface-2` or `--surface-3`.
- Don't tune a tracking ramp for a font the app does not actually load, and don't set
  tracking in `px` on a size that clamps.
- Don't animate `transform`, `scale`, or `translate` — not on entrance, not on press,
  not on hover. The two exceptions are named in § Motion and are a box's own size and the
  collapse chevron's rotation; a third has to be argued there before it ships.
- Don't use a native or offset focus ring. Indigo is reserved for actions, carets, and
  structural drops; focus stays inside the component's own visual language.
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
- Don't style a scrollbar in a component; there is one, and it is already declared.
- Don't cap a result's height so it scrolls inside a document that already scrolls, and
  don't put a second vertical scrollbar inside the content column.
- Don't write a fifth copy of "position this panel near that element" with a guessed
  panel height in it.
