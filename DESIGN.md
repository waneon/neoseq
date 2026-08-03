---
version: alpha
name: NeoSeq Design System
description: The design language for NeoSeq, a local-first outliner — a warm, paper-calm writing surface built on an off-white canvas, near-black Inter type, and a single confident blue, with a playful sticker palette reserved for decoration and a deliberately quiet application chrome of monochrome icons, portaled overlays, and opacity-only motion.

colors:
  primary: "#0075de"
  primary-active: "#005bab"
  secondary: "#213183"
  on-primary: "#ffffff"
  canvas: "#ffffff"
  canvas-soft: "#f6f5f4"
  surface: "#ffffff"
  ink: "#000000"
  ink-secondary: "#31302e"
  ink-muted: "#615d59"
  ink-faint: "#a39e98"
  ink-faint-accessible: "#6f6862"
  hairline: "#e6e6e6"
  surface-hover: "#f1f0ef"
  field-border: "#dcdbd9"
  accent-sky: "#62aef0"
  accent-purple: "#d6b6f6"
  accent-purple-deep: "#391c57"
  accent-pink: "#ff64c8"
  accent-orange: "#dd5b00"
  accent-orange-deep: "#793400"
  accent-teal: "#2a9d99"
  accent-green: "#1aae39"
  accent-brown: "#523410"
  danger: "#a03e00"
  danger-deep: "#793400"
  ok: "#1aae39"

typography:
  display-1:
    fontFamily: NotionInter
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: -2.125px
  display-2:
    fontFamily: NotionInter
    fontSize: 54px
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: -1.875px
  heading-1:
    fontFamily: NotionInter
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: -1px
  heading-2:
    fontFamily: NotionInter
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.23
    letterSpacing: -0.625px
  heading-3:
    fontFamily: NotionInter
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.27
    letterSpacing: -0.25px
  title:
    fontFamily: NotionInter
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: -0.125px
  body-md:
    fontFamily: NotionInter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: NotionInter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0
  button:
    fontFamily: NotionInter
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: NotionInter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 0
  eyebrow:
    fontFamily: NotionInter
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: 0.125px

rounded:
  xs: 4px
  sm: 5px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 28px
  xxl: 32px

# ─── Application extensions ───
# The blocks above describe the brand language. The blocks below capture the
# application-shell decisions the NeoSeq client implements on top of it.

motion:
  duration-press: 90ms
  duration-fast: 120ms
  duration-base: 150ms
  duration-enter: 220ms
  easing: ease
  entrance-property: opacity
  reduced-motion: honoured

layers:
  content: 0
  scrim: 25
  drawer: 30
  dialog: 50
  menu: 50
  popover: 60
  toast: 70

iconography:
  library: lucide
  size: 16px
  strokeWidth: 2.25
  color: "{colors.ink-faint-accessible}"
  color-hover: "{colors.ink-secondary}"

components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: 16px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
  button-primary-pressed:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.full}"
  button-utility:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 4px 14px
  button-icon-circular:
    backgroundColor: "rgba(0, 0, 0, 0.05)"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
  badge-pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.full}"
    padding: 4px 8px
  feature-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 24px
  feature-card-elevated:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  pricing-plan-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 24px
  pricing-plan-card-featured:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 24px
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    borderColor: "{colors.field-border}"
    rounded: 6px
    padding: 4px 12px
    height: 36px
    focusRing: "2px {colors.primary} @ 25%"
  hero-band:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.display-1}"
    padding: 32px
  footer:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.caption}"
    padding: 32px

  select-native:
    description: "Native <select> restyled to match text-input, with a chevron affordance. Stays native for AT and platform pickers."
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    borderColor: "{colors.field-border}"
    rounded: 6px
    height: 36px
    indicator: "{colors.ink-muted}"
  menu-surface:
    description: "Portaled dropdown-menu surface. Escapes scroll containers and stacking contexts so it is never clipped."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.xxs}"
    elevation: 2
    layer: "{layers.menu}"
  menu-item:
    description: "Row inside menu-surface; one highlight state shared by pointer and keyboard focus."
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: 6px
    padding: "6px {spacing.xs}"
    hoverBackground: "{colors.surface-hover}"
    destructiveColor: "{colors.danger}"
  popover-list:
    description: "Portaled autocomplete/option list anchored to its input in viewport coordinates."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.xxs}"
    elevation: 2
    layer: "{layers.popover}"
  tooltip:
    description: "Inverted micro-label for icon and shortcut affordances."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    typography: "{typography.eyebrow}"
    rounded: 6px
    padding: "6px 10px"
  icon-button:
    description: "Square, quiet control for chrome actions (menus, close, day stepping)."
    backgroundColor: transparent
    textColor: "{colors.ink-faint-accessible}"
    hoverBackground: "rgba(0, 0, 0, 0.05)"
    rounded: "{rounded.sm}"
    size: 28px
    pressTransform: "scale(0.92)"
  nav-item:
    description: "Sidebar navigation row; active state marked by an inset primary rule, not a fill."
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "5px {spacing.sm}"
    hoverBackground: "rgba(0, 0, 0, 0.05)"
    activeIndicator: "inset 2px 0 0 {colors.primary}"
  loading-indicator:
    description: "Delayed spinner for graph opening; suppressed below the flash threshold."
    textColor: "{colors.ink-faint-accessible}"
    delay: 220ms
    spinDuration: 800ms

  # ─── Examples (illustrative) — auto-derived; resolve any TO_FILL markers below ───
  ex-pricing-tier:
    description: "Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface."
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  ex-pricing-tier-featured:
    description: "Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode)."
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  ex-product-selector:
    description: "What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery)."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  ex-cart-drawer:
    description: "Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart)."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    item-divider: "{colors.hairline}"
  ex-app-shell-row:
    description: "Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator."
    backgroundColor: "{colors.canvas}"
    activeIndicator: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
  ex-data-table-cell:
    description: "Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm."
    headerBackground: "{colors.canvas-soft}"
    headerTypography: "{typography.eyebrow}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.sm} {spacing.md}"
    rowBorder: "{colors.hairline}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  ex-modal-card:
    description: "Modal dialog surface — same chrome as feature-card with elevated shadow."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
  ex-empty-state-card:
    description: "Empty-state illustration frame."
    backgroundColor: "{colors.canvas-soft}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xxl}"
    captionTypography: "{typography.body-md}"
  ex-toast:
    description: "Toast notification surface — feature-card shape + medium shadow."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.sm} {spacing.md}"
    typography: "{typography.body-sm}"

---


## Overview

Notion looks like a well-organized desk in good daylight. The dominant surface is not pure white but a warm, paper-soft off-white — `{colors.canvas-soft}` (#f6f5f4) — that takes the clinical edge off the screen and makes long pages feel like a document rather than an app. Type is set in `NotionInter` (a tuned Inter) in near-black `{colors.ink}` at large, tightly-tracked weights, so headlines read as confident statements with very little letter-spacing slack at display sizes (`{typography.display-1}` pulls −2.125px of tracking at 64px). The whole system whispers in greys and blacks, then says exactly one thing in colour: a single, dependable blue, `{colors.primary}` (#0075de), reserved almost entirely for the primary call-to-action and inline links.

Against that quiet chrome, Notion lets a **playful multi-colour sticker palette** carry all of the brand's personality — purple, pink, orange, teal, green and sky-blue appear as small illustrated blocks, app-icon stickers, and category dots scattered through the marketing pages. These colours never structure the layout or paint a CTA; they decorate. The discipline is deliberate: the interface stays monochrome-plus-blue so the content (and the cheerful illustrations) can breathe. The one exception to the bright daylight is the homepage hero, which inverts into a deep indigo "night" band (`{colors.secondary}`) with white type and glowing sticker constellations — a single dark island in an otherwise light document.

Surfaces are defined by hairlines and the faintest layered shadows rather than heavy elevation. Cards round at a friendly 12px (`{rounded.lg}`), the marketing CTAs are fully-pill-shaped (`{rounded.full}`), and utility buttons round at a tighter 8px (`{rounded.md}`). Nothing is loud; the brand's character comes from restraint plus one well-placed splash of joy.

**Key Characteristics:**
- Warm paper-soft canvas `{colors.canvas-soft}` over pure white, never clinical
- Near-black `{colors.ink}` `NotionInter` type with tight negative tracking at display sizes (`{typography.display-1}`)
- Exactly one structural accent — Notion blue `{colors.primary}` — reserved for CTAs and links
- A decorative-only multi-colour sticker palette (`{colors.accent-purple}`, `{colors.accent-pink}`, `{colors.accent-orange}`, `{colors.accent-teal}`, `{colors.accent-green}`, `{colors.accent-sky}`) that adds personality without ever painting structure
- Pill-shaped marketing CTAs (`{rounded.full}`) contrasted with 8px utility buttons (`{rounded.md}`)
- Elevation by hairline + barely-there layered shadow, not heavy drop-shadows
- A single dark indigo hero "night" band (`{colors.secondary}`) inverting the otherwise daylight page rhythm

## Colors

> Source pages analysed: the Notion home page plus Pricing, Enterprise, Product (AI), Product (Agents), and Startups. Every secondary page resolved to the same core palette — Notion runs one tightly-scoped system across the marketing site.

### Brand & Accent
- **Notion Blue** (`{colors.primary}` — #0075de): the single structural accent. Primary CTA fill ("Get Notion free"), inline link colour, active-tab and focus signal. This is the only colour that ever paints an action.
- **Pressed Blue** (`{colors.primary-active}` — #005bab): the darker press state of the primary CTA.
- **Deep Indigo** (`{colors.secondary}` — #213183): the dark hero "night" band background and its sticker-constellation field; a deep brand-blue used for full-bleed inverted sections.

The remaining colours form Notion's **decorative sticker palette** — they appear only as illustrated blocks, app stickers and category dots, never as CTAs or structural fills:
- **Sticker Sky** (`{colors.accent-sky}` — #62aef0)
- **Sticker Purple** (`{colors.accent-purple}` — #d6b6f6) / **Deep Purple** (`{colors.accent-purple-deep}` — #391c57)
- **Sticker Pink** (`{colors.accent-pink}` — #ff64c8)
- **Sticker Orange** (`{colors.accent-orange}` — #dd5b00) / **Deep Orange** (`{colors.accent-orange-deep}` — #793400)
- **Sticker Teal** (`{colors.accent-teal}` — #2a9d99)
- **Sticker Green** (`{colors.accent-green}` — #1aae39)
- **Sticker Brown** (`{colors.accent-brown}` — #523410)

### Surface
- **White** (`{colors.canvas}` / `{colors.surface}` — #ffffff): card and panel surfaces, nav bar, form fields.
- **Warm Paper** (`{colors.canvas-soft}` — #f6f5f4): the signature page canvas and the footer band — a warm off-white that gives the whole site its document-like calm.
- **Hairline** (`{colors.hairline}` — #e6e6e6): 1px card borders and dividers, a black-at-10%-on-white blend kept solid for token reuse.
- **Surface Hover** (`{colors.surface-hover}` — #f1f0ef): the hover/highlight wash for menu rows, option rows and list items — one step darker than the page canvas so a highlighted row reads against it.
- **Field Border** (`{colors.field-border}` — #dcdbd9): the 1px resting border of inputs and selects. Slightly warmer than `{colors.hairline}` so a control reads as interactive next to a static divider.

### Text
- **Ink** (`{colors.ink}` — #000000): primary headings and body text (rendered at ~95% alpha for a soft true-black).
- **Warm Charcoal** (`{colors.ink-secondary}` — #31302e): secondary body copy and footer text.
- **Stone** (`{colors.ink-muted}` — #615d59): supporting / muted copy.
- **Ash** (`{colors.ink-faint}` — #a39e98): the brand's caption/metadata grey. At 2.4:1 on white it is a *marketing* value and fails WCAG AA for body text.
- **Ash (accessible)** (`{colors.ink-faint-accessible}` — #6f6862): the substitute the application ships wherever Ash would carry real text — captions, metadata, placeholders, icon glyphs. It holds the same quiet position in the hierarchy at 5.6:1 on white. **Use this token in product UI; reserve `{colors.ink-faint}` for decorative, non-text use.**
  > Implementation note: the application's `--color-ink-faint` variable already resolves to this accessible value. That is deliberate — do not "restore" it to the marketing hex.

### Semantic
Notion's marketing surfaces do not expose a dedicated error/success palette in the system chrome — status is carried by the sticker palette (e.g. `{colors.accent-green}` for affirmative ticks) rather than a separate semantic ramp.

A product that can fail to save needs one, so the application adds a minimal, deliberately un-loud ramp:

- **Danger** (`{colors.danger}` — #a03e00): destructive actions and unsaved/error states. A burnt orange drawn from the sticker palette's warm end rather than a siren red — it reads as serious without shouting on a paper canvas, and clears AA on white.
- **Danger Deep** (`{colors.danger-deep}` — #793400): text on tinted danger surfaces.
- **OK** (`{colors.ok}` — #1aae39): the durable/saved indicator, used as a small dot rather than a fill.

Status is signalled by a dot plus a *word* — never by hue alone.

## Typography

### Font Family
The entire system is set in **`NotionInter`** — Notion's tuned cut of Inter — with a fallback stack of `Inter, -apple-system, system-ui, "Segoe UI", Helvetica, Arial`. A single family carries everything from 64px display headlines to 12px eyebrows; there is no serif, no monospace display face. OpenType `lnum` (lining numerals) and `locl` features are enabled on body and heading roles.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|
| `{typography.display-1}` | 64px | 700 | 1.0 | −2.125px | Hero headline ("Meet the night shift") |
| `{typography.display-2}` | 54px | 700 | 1.04 | −1.875px | Large section headlines |
| `{typography.heading-1}` | 40px | 700 | 1.1 | −1px | Section headlines ("Plans and features") |
| `{typography.heading-2}` | 26px | 700 | 1.23 | −0.625px | Sub-section headings |
| `{typography.heading-3}` | 22px | 700 | 1.27 | −0.25px | Card titles |
| `{typography.title}` | 20px | 600 | 1.4 | −0.125px | Feature titles, callouts |
| `{typography.body-md}` | 16px | 400 | 1.5 | 0 | Default body copy |
| `{typography.body-sm}` | 15px | 400 | 1.33 | 0 | Dense body, table rows, nav |
| `{typography.button}` | 16px | 500 | 1.5 | 0 | Button labels |
| `{typography.caption}` | 14px | 400 | 1.43 | 0 | Captions, footnotes |
| `{typography.eyebrow}` | 12px | 600 | 1.33 | +0.125px | Pill badges, small labels |

### Principles
Notion's type voice is **tight, heavy, and quiet-confident**. Headlines lean on weight 700 and aggressive negative tracking (more negative the larger the size) so display copy feels set, not stretched. Body copy stays at a comfortable 1.5 line-height for document readability. The contrast between a heavy 700 headline and a calm 400 body is the primary expressive lever — there is no decorative typography, only a clear hierarchy.

### Note on Font Substitutes
`NotionInter` is a proprietary tuning of the open-source **Inter** family — substitute Inter directly. To approximate Notion's display tightness, apply the negative letter-spacing values in the table above explicitly (Inter at default tracking will read looser than `NotionInter`).

## Layout

### Spacing System
- **Base unit**: 8px.
- **Tokens (front matter)**: `{spacing.xxs}` 4px · `{spacing.xs}` 8px · `{spacing.sm}` 12px · `{spacing.md}` 16px · `{spacing.lg}` 24px · `{spacing.xl}` 28px · `{spacing.xxl}` 32px.
- Card interior padding lands around `{spacing.lg}` (24px); utility buttons use a tight 4px/14px; form fields pad at `{spacing.xxs}`-scale 6px. Section gaps stack the larger steps.

### Grid & Container
Content is centred in a wide max-width column (~1080–1300px on desktop per the extracted breakpoints) with generous outer gutters. Feature sections alternate between full-width text blocks and 2-up / 3-up card grids; the pricing page widens to a 4-column plan table. The dark hero spans full-bleed edge to edge while body sections respect the centred container.

### Whitespace Philosophy
Whitespace is the primary grouping device. Sections are separated by large vertical gaps rather than rules, and cards sit on the warm canvas with quiet hairlines instead of heavy frames. The effect is document-like: airy, scannable, and never crowded.

### Application Shell

The product surface is a two-column shell: a 248px navigation rail and a content
column, with the marketing container rules applying *inside* the content column
(the page body stays a centred ~760px measure).

**Only one region scrolls.** The shell itself is viewport-height and never
scrolls; the sidebar is pinned and scrolls internally only when its own nav
overflows; the page content scrolls inside its own region beneath a static top
bar. Navigation must never drift out of reach because the document is long — a
scroll position in the content is not a change in navigation state.

Below the tablet breakpoint the rail becomes an off-canvas drawer over a scrim
(`{layers.drawer}` / `{layers.scrim}`), toggled from the top bar.

### Responsive Strategy

#### Breakpoints
| Name | Width | Key Changes |
|---|---|---|
| Wide | 1440px+ | Full multi-column grids, widest container |
| Desktop | 1080–1300px | Standard centred container, 3-up card grids |
| Tablet | 768–840px | Grids collapse to 2-up, nav begins condensing |
| Mobile | ≤600px | Single-column stacks, hamburger nav, full-width CTAs |

#### Touch Targets
Pill CTAs (`button-primary`, `button-secondary`) and utility buttons (`button-utility`) carry comfortable tap padding; aim for a 44×44px minimum hit area on mobile by preserving vertical padding even as labels shrink.

#### Collapsing Strategy
The top nav condenses to a hamburger below the tablet breakpoint; multi-column card grids collapse to a single stacked column; the pricing plan table reflows from 4 side-by-side columns into stacked plan cards. Section padding tightens but the warm-canvas rhythm is preserved.

#### Image Behavior
Product screenshots and illustration tiles sit inside rounded `{rounded.lg}` frames and scale fluidly within their grid cell. Sticker illustrations are small fixed-scale decorative assets that re-flow but do not crop.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 — Flat | Hairline border `{colors.hairline}`, no shadow | Default cards on the warm canvas |
| 1 — Soft | Layered micro-shadow: `rgba(0,0,0,0.01) 0 0.175px 1.041px`, `0.02 0 0.8px 2.925px`, `0.027 0 2.025px 7.847px`, `0.04 0 4px 18px` | Raised feature cards, floating buttons |
| 2 — Elevated | Deeper 5-stop stack ending in `rgba(0,0,0,0.05) 0 23px 52px` | Modals, popovers, the elevated white pill on the dark hero |

Notion's elevation philosophy is **barely-there**: shadows are built from many near-transparent layers so surfaces feel gently lifted off the paper rather than dramatically dropped. Most cards rely on a hairline alone.

### Layering & Overlays

Anything that floats above the page owns a slot on one shared scale, so two
overlays can never fight for the front:

| Token | Value | Use |
|---|---|---|
| `{layers.content}` | 0 | Ordinary page content |
| `{layers.scrim}` | 25 | Dimmer behind the mobile drawer |
| `{layers.drawer}` | 30 | Off-canvas sidebar |
| `{layers.dialog}` / `{layers.menu}` | 50 | Modal dialogs, dropdown menus |
| `{layers.popover}` | 60 | Autocomplete and option lists (may open *from inside* a dialog) |
| `{layers.toast}` | 70 | Transient status, always frontmost *(slot reserved; no toast component ships yet)* |

**Overlays render in a portal, never inline.** A menu or option list anchored
inside a scrolling, clipping, or transformed ancestor — the virtualized outline
is all three — cannot escape that ancestor with `z-index` alone. Portal it to
the document and position it in viewport coordinates, re-anchoring on scroll and
resize. A raised `z-index` on an inline overlay is a symptom, not a fix.

**Every overlay is dismissible the ways users expect**: click or tap outside,
`Escape`, and selecting an item. An overlay that only closes by re-clicking its
own trigger is a defect.

### Decorative Depth
The brand's real depth cue is **illustration**, not shadow. The dark indigo hero (`{colors.secondary}`) uses glowing sticker stickers and a starfield to create a sense of a lit night scene, and feature sections layer small colourful app-icon stickers over plain surfaces to add playful dimensionality. Colour-blocked illustration tiles (purple, pink, orange, teal headers on otherwise-white cards) provide visual rhythm.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.xs}` | 4px | Form fields, small tags, inline chips |
| `{rounded.sm}` | 5px | Menu items, list rows, status pills |
| `{rounded.md}` | 8px | Utility / nav buttons, smaller cards |
| `{rounded.lg}` | 12px | Feature cards, illustration frames, content tiles |
| `{rounded.xl}` | 16px | Large containers, image wells |
| `{rounded.full}` | 9999px | Marketing pill CTAs, badges, circular icon buttons |

### Photography Geometry
Product screenshots are framed in rounded `{rounded.lg}` / `{rounded.xl}` wells, typically full-bleed within their container with a hairline edge. Illustration tiles use colour-blocked header bands above white card bodies. Avatars and app-icon stickers are small, sometimes fully circular (`{rounded.full}`). There is no heavy art-direction crop — images scale within their rounded frame.

## Components

> **Marketing specs document Default and Active/Pressed only** — no hover states were observable in the source material. The *application* components below do define hover, focus and disabled states; see [Interaction States](#interaction-states). Variants live as separate `components:` front-matter entries and are described in their own sub-blocks.

### Navigation

**`nav-bar`** — Top navigation
- White surface `{colors.canvas}`, `{colors.ink}` link text at `{typography.body-sm}`, padding `{spacing.md}`. Sits as a slim sticky bar; left wordmark, centre product/solutions menu links, right "Log in" text link plus a `button-utility` "Get Notion free" CTA. Condenses to a hamburger below the tablet breakpoint.

**`nav-item`** — Sidebar navigation row
- `{colors.ink-secondary}` label at `{typography.body-sm}`, rounded `{rounded.sm}`, padding `5px {spacing.sm}`, leading 16px icon. Hover washes to `rgba(0,0,0,0.05)`; the current page is marked by an inset 2px `{colors.primary}` rule plus a faint fill — an indicator, never a saturated bar. Long page titles truncate with an ellipsis rather than wrapping the row.

### Buttons

**`button-primary`** — Primary CTA ("Get Notion free")
- Background `{colors.primary}`, text `{colors.on-primary}`, type `{typography.button}`, fully pill-shaped `{rounded.full}`. The single blue action on any page.
- Pressed state lives in `button-primary-pressed` (background `{colors.primary-active}`); marketing buttons also apply a brief `scale(0.9)` press transform.

**`button-primary-pressed`**
- Background `{colors.primary-active}`, text `{colors.on-primary}` — the depressed state of the primary CTA.

**`button-secondary`** — Secondary CTA ("Request a demo")
- White surface `{colors.surface}`, text `{colors.ink}`, type `{typography.button}`, pill `{rounded.full}`, carried by the soft Level-1 shadow. Pairs beside `button-primary` in the hero.

**`button-utility`** — Nav / plan-select button
- White surface `{colors.surface}`, text `{colors.ink}`, type `{typography.button}`, tighter `{rounded.md}` (8px), padding `4px 14px`, 1px `{colors.hairline}` border. Used for the nav CTA and pricing plan-select buttons where the marketing pill would be too large.

**`button-icon-circular`** — Carousel / media control
- Circular `{rounded.full}` control with a translucent `rgba(0,0,0,0.05)` fill and `{colors.on-primary}` glyph, used for slide and play/pause controls; applies a `scale(0.9)` press transform.

**`icon-button`** — Chrome icon control
- 28px square, transparent by default, `{rounded.sm}`, 16px glyph in `{colors.ink-faint-accessible}`. Hover fills `rgba(0,0,0,0.05)` and darkens the glyph to `{colors.ink-secondary}`; press applies `scale(0.92)`. Used for row menus, close, and date stepping — the quiet counterpart to a labelled button.
- **Row-scoped variants may fade in on hover** (e.g. the block ⋯ trigger), but must remain in the layout and become fully visible on `:focus-within`, so keyboard users can always reach them. Never `display: none` an action that exists.

### Cards & Containers

**`feature-card`** — Content / feature card
- White surface `{colors.surface}`, `{colors.ink}` text, `{typography.body-md}`, rounded `{rounded.lg}` (12px), padding `{spacing.lg}` (24px). The workhorse marketing card; often topped by a colour-blocked illustration band from the sticker palette. Default elevation is flat (hairline only).

**`feature-card-elevated`** — Raised feature card
- Same chrome as `feature-card` with the soft Level-1 layered shadow for cards that float above the canvas (testimonials, floating product panels).

**`pricing-plan-card`** — Pricing plan column
- White surface `{colors.surface}`, `{colors.ink}` text, `{typography.body-sm}`, rounded `{rounded.md}` (8px), padding `{spacing.lg}`. A bordered column listing a plan's price and feature checklist, with a `button-utility` select action.

**`pricing-plan-card-featured`** — Highlighted plan column
- Warm `{colors.canvas-soft}` fill to lift the recommended tier off the white siblings, same `{rounded.md}` shape and padding. Distinguished by surface tint rather than a coloured border.

### Inputs & Forms

**`text-input`** — Text / number / date field
- White surface `{colors.surface}`, `{colors.ink}` text at `{typography.caption}`, 1px `{colors.field-border}`, rounded 6px, padding `4px 12px`, 36px tall. Corners stay deliberately tighter than the pill CTAs. Focus moves the border to `{colors.primary}` and adds a 2px primary ring at 25% — a visible, non-shifting focus signal rather than a shadow bloom.
- Placeholders use `{colors.ink-faint-accessible}`; they are a hint, never the only label. Every field carries a programmatic label even when the visual design shows none.

**`select-native`** — Enumerated choice
- Matches `text-input` chrome exactly (same height, border, radius, type) with a trailing `{colors.ink-muted}` chevron and no native OS arrow.
- **This stays a real `<select>`.** Custom listbox widgets are not used for value entry: the native control brings platform pickers, mobile wheels, type-ahead and AT support for free. Restyle it; do not replace it. The same rule holds for checkboxes and date fields — tint and size them, keep them native.

**Field composition.** Where a row composes several controls (a key field, a type select, a value control and a submit button), every control in the row shares one height and the row aligns on a single centre line. A value control that swaps by type — text, number, date, checkbox, page picker — must not change the row's height or rhythm; short controls such as a checkbox are centred in a full-height cell rather than left to float.

### Overlays

**`menu-surface`** / **`menu-item`** — Contextual action menu
- Portaled surface: `{colors.surface}`, 1px `{colors.hairline}`, `{rounded.md}`, `{spacing.xxs}` padding, Level-2 elevation, `{layers.menu}`.
- Items are `{typography.caption}` in `{colors.ink}` with a leading 16px glyph, 6px radius, `6px {spacing.xs}` padding. One highlight state (`{colors.surface-hover}`) serves both pointer hover and keyboard focus, so the two never disagree. Destructive items take `{colors.danger}` for both label and glyph. Unavailable items stay visible at reduced opacity — the menu's shape should not change as context changes.
- Grouped by intent with hairline separators: inspect, then structure, then destroy.

**`popover-list`** — Autocomplete / option list
- Same chrome as `menu-surface` at `{layers.popover}`, anchored to its input in viewport coordinates and re-anchored on scroll and resize. Scrolls internally past ~264px with contained overscroll.
- The active option is highlighted with `{colors.surface-hover}` and tracked as the input's active descendant, so arrow keys and the pointer drive one shared selection. An empty result is a status message beside the list, not a fake option.

**`tooltip`** — Micro-label
- Inverted: `{colors.ink}` surface, `{colors.on-primary}` text at `{typography.eyebrow}`, 6px radius, `6px 10px` padding, ~300ms open delay. Reserved for naming an icon control or surfacing a keyboard shortcut. A tooltip may repeat or extend an accessible name; it must never be the only place that name exists.

### Signature Components

**`hero-band`** — Dark "night" hero
- Full-bleed deep indigo `{colors.secondary}` band carrying `{typography.display-1}` white headline, sticker-constellation field, and a `button-primary` + `button-secondary` CTA pair. The single inverted dark island in an otherwise daylight page.

**`badge-pill`** — Eyebrow / category pill
- White surface `{colors.surface}`, `{colors.primary}` text, `{typography.eyebrow}` (12px / 600), fully pill `{rounded.full}`, padding `4px 8px`. Small labels such as the pricing "Essential for staying organized" eyebrow and category tags.

**`footer`** — Site footer
- Warm `{colors.canvas-soft}` band, `{colors.ink-secondary}` link text at `{typography.caption}`, padding `{spacing.xxl}`. Multi-column link directory closing every page.

### Examples (illustrative)

> Kit-mirror demonstration surfaces. Each `ex-*` entry references brand-native primitives so downstream consumers (`/preview-design`, `/generate-kit`) re-skin the same 10 surfaces consistently.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).
- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.
- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.
- Properties: `backgroundColor`, `rounded`, `padding`, `typography`


## Motion

Motion exists to explain a change, not to decorate it. A state change that lands
instantly reads as a glitch; one that lingers reads as slow software. The brand's
restraint applies to time exactly as it applies to colour: **short, quiet, and
never more than the change requires.**

### Duration Scale

| Token | Value | Use |
|---|---|---|
| `{motion.duration-press}` | 90ms | Press transforms — must feel simultaneous with the finger |
| `{motion.duration-fast}` | 120ms | Hover washes, colour and icon tint changes |
| `{motion.duration-base}` | 150ms | Overlay entrances, inline panel reveals |
| `{motion.duration-enter}` | 220ms | Content arriving after navigation; the loading-flash threshold |

Everything uses plain `ease` (or `ease-out`). There is no spring, bounce, or
overshoot — an outliner is a writing tool, and elastic motion in a text surface
reads as instability.

### Entrances are opacity-only

**Animate `opacity`. Do not animate position, scale, or size on anything the user
may be about to click or read.** This is a correctness rule, not a taste one:

- A moving target is unclickable. An overlay that slides or scales while the
  pointer is already travelling toward it causes mis-clicks and, in automation,
  "element is not stable" failures.
- Text mid-fade composites against its background at partial alpha, so a
  container fading in transiently fails contrast for everything inside it. Any
  surface whose text is measured (or read) on arrival must not be fading.

Two consequences worth stating plainly:

- **Overlays animate in, never out.** A closing menu should leave immediately;
  a lingering ghost is a target that no longer works.
- **Surfaces that are evaluated the moment they mount do not animate at all.**
  Prefer no animation to an animation that has to finish before the surface is
  legible.

### Reduced Motion

`prefers-reduced-motion: reduce` collapses every duration to effectively zero
globally. Nothing in the product may depend on an animation having run to be
usable or understandable.

## Iconography

Icons are **chrome, not content** — they orient, they never carry the message.

- One monochrome family ([lucide](https://lucide.dev)) at **16px**, stroke weight
  **2.25** — slightly heavier than default so a small grey glyph stays crisp
  beside 15px text.
- Resting colour `{colors.ink-faint-accessible}`, rising to
  `{colors.ink-secondary}` on hover and in the active nav row.
- **No multi-colour emoji in the chrome.** Emoji drag in another type family and
  another palette, render differently per platform, and pull attention toward
  navigation and away from the user's own writing. The sticker palette's job is
  personality in illustration — not wayfinding.
- Every icon-only control carries an accessible name; every icon beside a text
  label is marked decorative so it is not announced twice.

## Interaction States

Every interactive element defines all five. A control that only styles its
default state is unfinished.

| State | Treatment |
|---|---|
| Default | As specified per component |
| Hover | `rgba(0,0,0,0.05)` wash (chrome) or `{colors.surface-hover}` (list/menu rows); glyphs darken one step |
| Focus | 2px `{colors.primary}` ring, offset 1px, on a visible outline — never removed, never replaced by colour alone |
| Active/Pressed | `scale(0.97)` for buttons, `scale(0.92)` for icon buttons; primary CTAs also darken to `{colors.primary-active}` |
| Disabled | ~50% opacity, pointer events off, still present in the layout and still announced |

Hover and keyboard focus share one highlight in menus and option lists, so
"where am I" never has two answers.

## Loading & Feedback

- **Below the flash threshold, show nothing.** Local work usually completes in
  well under `{motion.duration-enter}`; a spinner that appears and vanishes
  inside that window reads as a flicker and makes fast software feel broken.
  Delay the indicator by 220ms and let quick operations complete silently.
- Past that threshold, fade in a quiet spinner in `{colors.ink-faint-accessible}`
  with a short label. It is calm and centred, not a full-bleed takeover — the
  surrounding chrome stays put so the layout does not jump when content lands.
- Durability is ambient, not modal: the save state lives as a small
  `status-pill` in the top bar (`saved` green, `saving` blue, `unsaved` warm
  danger with a retry). Editing is never blocked by it.
- Empty states are invitations with an action attached ("Click to start
  writing…"), never bare apologies.

## Implementation

The design language is implemented as Tailwind CSS v4 + shadcn/ui primitives
built on Radix, layered over this token set rather than replacing it.

- **Tokens stay canonical.** The `--color-*`, `--radius-*` and `--space-*`
  variables in `ui/app.css` are the source of truth; `ui/globals.css` bridges
  them onto shadcn's semantic variables (`--background`, `--primary`,
  `--muted-foreground`, `--radius`, …) via `@theme inline`. A shadcn primitive
  therefore inherits the Notion palette by construction, and no component
  hard-codes a hex value.
- **Radix supplies behaviour, this document supplies appearance.** Portalling,
  focus trapping, dismissal, roving focus and ARIA wiring come from the
  primitive; every visual property comes from the tokens above.
- **Radius mapping.** shadcn's scale derives from `--radius: 8px`, which lands
  the utilities on this document's scale:

| Utility | Computed | Token |
|---|---|---|
| `rounded-sm` | 4px | `{rounded.xs}` |
| `rounded-md` | 6px | form controls, menu rows |
| `rounded-lg` | 8px | `{rounded.md}` |
| `rounded-xl` | 12px | `{rounded.lg}` |
| `rounded-2xl` | 16px | `{rounded.xl}` |

- **Native where native is better.** Selects, checkboxes and date fields remain
  real form controls; shadcn/Radix is used for overlays and chrome, where the
  platform offers nothing equivalent.


## Do's and Don'ts

### Do
- Reserve `{colors.primary}` for the primary action, inline links, and the active/focus signal — nothing decorative.
- Keep the page on the warm `{colors.canvas-soft}` canvas; use pure white `{colors.surface}` for cards and fields to create gentle figure/ground.
- Let the sticker palette (`{colors.accent-pink}`, `{colors.accent-teal}`, `{colors.accent-orange}`, …) live only in illustrations, icon tiles and category dots.
- Set headlines in heavy `{typography.display-1}`/`{typography.heading-1}` with their negative tracking applied explicitly.
- Use pill `{rounded.full}` for marketing CTAs and tighter `{rounded.md}` for nav/utility buttons — the contrast is intentional.
- Define surfaces with `{colors.hairline}` and the barely-there Level-1 shadow rather than heavy drop-shadows.
- Reserve the deep indigo `{colors.secondary}` "night" treatment for a single hero moment, not repeated bands.
- Render every floating surface in a portal and place it on the shared `{layers.*}` scale.
- Animate `opacity` only, in 90–220ms, with `ease`.
- Use `{colors.ink-faint-accessible}` wherever a faint grey carries real text.
- Give every interactive element all five states — including a visible focus ring.
- Pin the navigation and let exactly one region scroll.
- Keep selects, checkboxes and date fields native; restyle rather than rebuild.
- Delay loading indicators past 220ms so fast work completes silently.

### Don't
- Don't paint a CTA or structural fill in any sticker-palette colour — those are decoration only.
- Don't introduce a second structural accent alongside `{colors.primary}`.
- Don't put pill `{rounded.full}` radii on form fields — inputs stay tight (4–6px).
- Don't reach for a bigger `z-index` to escape a clipping or transformed ancestor; portal the overlay instead.
- Don't animate transform, size, or position on anything clickable, and don't fade a container whose text is read or measured as it mounts.
- Don't let an overlay linger on close, or close only by re-clicking its trigger — outside click and `Escape` must both work.
- Don't use emoji as interface icons, and don't tint chrome glyphs with the sticker palette.
- Don't replace a native form control with a custom widget for value entry.
- Don't set body or caption text in `{colors.ink-faint}` — it fails AA on white; that token is for decoration.
- Don't show a spinner for work that usually finishes in under 220ms.
- Don't drop heavy shadows; Notion's elevation is many near-transparent layers, never a hard cast.
- Don't set body copy in a heavy weight — keep 400 for readability and let weight 700 belong to headlines.
- Don't place type on pure clinical white for full pages; the warm `{colors.canvas-soft}` is core to the brand calm.
