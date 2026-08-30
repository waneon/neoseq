# Shell and Navigation Design Architecture

## Boundary

The shell establishes place, global navigation, and access to product-wide
capabilities. It owns the rail, top bar, command entrance, settings container,
and graph-opening experience. Page bodies and feature-specific contextual
controls belong to their focused design areas.

## Spatial Model

The application frame has one navigation region and one content region. The
content region is the primary scroller; the frame itself does not scroll. This
keeps navigation, overlay positioning, and return-to-caret behavior independent
from document length.

On wide screens the rail is a stable column that may collapse. On narrow screens
it becomes an off-canvas drawer and is inert while closed. The content measure
and gutter adapt to the viewport without changing the hierarchy of page edge,
outline inset, and floating layers.

## Navigation Rail

The rail is quieter than the writing canvas. Its head identifies the product and
current graph; search has the visual shape of the field it opens. The current row
uses the accent because the rail is scanned for location rather than read as
content.

Favourites form one list across pages and tags: the organizing idea is return,
not entity type. Each item retains its own mark, and all labels share one mark
column. The list is absent when empty. Favourite membership and order belong to
the graph, and reordering has equivalent drag and keyboard routes.

Page and tag directories remain distinct below favourites because they describe
the graph's structure rather than a personal shortcut set.

## Top Bar

At rest the top bar is page margin for controls that belong to the window rather
than the page. It gains an opaque ground, edge, and the departed page title only
when content scrolls beneath it. Its geometry remains stable during that change.

The top bar exposes place and one registry-backed contextual menu; it does not
become a toolbar of named feature verbs. Surface-specific primary controls, such
as journal date navigation or a query's view switcher, may remain visible because
they define how that surface is used.

## Disclosure and Commands

Permanent chrome is intentionally small. A secondary control may be hidden at
rest only when it is:

- revealed by both hover and focus;
- pinned or otherwise reachable on touch; and
- available through the command or context layer.

The primary verb of a surface is never hover-gated. A hover-only route cannot be
the sole discovery path for any capability.

One command registry owns labels, availability, bindings, scopes, disabled
reasons, execution, and a required pointer route. One arbitration order handles
IME composition, the topmost overlay, editor commands, and global commands.
Global shortcuts do not steal unmodified typing keys from text fields.

The command palette is the global navigation and action entrance. It remains a
stable size while results change, ranks navigation first, explains unavailable
commands, always offers a next action, and restores the prior caret on close.
Bindings, help, and visible key badges read from the same resolved shortcut
table.

## Settings

Settings is a dialog with explicit browser-wide and graph-specific scopes. A
URL-addressable open state allows browser Back to close it without turning it
into a separate application route.

The dialog keeps one frame size across sections so navigation does not move under
the pointer. The section list remains stable while the active pane scrolls or
stacks responsively. Appearance choices preview their actual product role, and
bounded color choices are selected from visible swatches rather than a free-form
picker.

Graph-owned standing queries are authored here with the same query grammar used
elsewhere. Settings owns their graph-level lifecycle; the answer surface owns
how a reader shapes a saved view.

## First Light

The graph-opening screen is the one product surface optimized for first
impression rather than sustained work. It uses a narrow, centered composition,
bounded graph cards, and a restrained accent atmosphere. Once a graph is open,
decoration yields to structure and authored content.

Repositories form one horizontal index above the graph list. Local is the
stable first tab; each remote tab represents exactly one server account, and an
adjacent `+` opens the connection dialog. Selecting a tab changes the scope of
listing, creation, and archive import together. The active tab uses a single
accent underline rather than a filled pill, keeping the graph cards as the
screen's primary objects. Tabs may scroll horizontally without wrapping or
moving the add control.

## Responsive Contract

Responsive changes preserve capability and hierarchy:

- the rail becomes a drawer rather than disappearing;
- settings panes stack without mixing their scopes;
- touch targets grow and hover-revealed controls become explicit;
- long-press reaches the same contextual actions as a pointer context menu; and
- overlays remain within the available viewport rather than forcing shell
  scrolling.

Shared control, overlay, and feedback behavior follows
[Interaction](interaction.md); target and keyboard requirements follow
[Accessibility](accessibility.md).
