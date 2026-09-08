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
current graph; search has the visual shape of the field it opens. A labeled New
page action sits beside search in the stable head and is disabled for read-only
graphs. The directory scrolls independently between this head and the settings
and keyboard-help footer. The desktop collapse control is always visible. The current row
uses the accent because the rail is scanned for location rather than read as
content. Journal remains the current place on every dated journal route.

Directory labels use the shared small-text role and content ink. Section labels
use the secondary ink role; compact section spacing establishes grouping without
large empty bands. Desktop rows stay dense, while touch rows retain full targets.

Favourites form one list across pages and tags: the organizing idea is return,
not entity type. Each item retains its own mark, and all labels share one mark
column. The list is absent when empty. Favourite membership and order belong to
the graph, and reordering has equivalent drag and keyboard routes.

Journal and Tags are primary destinations. The page directory follows favourites
and shows its size without displacing its labels. Page creation remains available
above the directory at every scroll position.

## Top Bar

The top bar is a persistent, fine-edged orientation strip. A breadcrumb names the
workspace and current document even before scrolling. On narrow screens it keeps
the current place and omits the workspace prefix. Registry-backed Undo and Redo
remain available beside exceptional save or collaboration state. Search also
appears here whenever the rail is collapsed or becomes a drawer.

The page header owns the document's context, title, and surface-specific controls,
including journal date navigation. Context and actions share a compact row above
the full-width title, so long names never compete with controls for width.

## Disclosure and Commands

Permanent chrome is intentionally small. A secondary control may be hidden at
rest only when it is:

- revealed by both hover and focus;
- pinned or otherwise reachable on touch; and
- available through the command or context layer.

The primary verb of a surface is never hover-gated. Page actions have a persistent
trigger beside the title; context click opens that same anchored menu. The trigger
is also the focus owner when a journal has no editable title. Query configuration
remains visible so a new answer can be shaped without discovering a hidden toolbar.

One command registry owns labels, availability, bindings, scopes, disabled
reasons, execution, and a required pointer route. One arbitration order handles
IME composition, the topmost overlay, editor commands, and global commands.
Global shortcuts do not steal unmodified typing keys from text fields.

The command palette is the global navigation and action entrance. It remains a
stable size while results change, ranks navigation first, explains unavailable
commands, always offers a next action, and restores the prior caret on close.
An explicit close control remains available when the palette fills a touch
screen. Tab cycles between the search field and that close control; options
retain combobox navigation. Bindings, help, and visible key badges read from
the same resolved shortcut table.

## Settings

Settings is a dialog with explicit browser-wide and graph-specific scopes. A
URL-addressable open state allows browser Back to close it without turning it
into a separate application route.
Opening, switching, or closing settings preserves the invoking navigation drawer
and returns focus to its control. Following a rail link closes the drawer,
including a link to the current page; keyboard invocation preserves the editor's
caret instead.

The dialog keeps a spacious, stable frame across sections so navigation does not
move under the pointer. Its sidebar groups application preferences for this
device separately from the current graph. Each pane uses a consistent heading
and description to establish purpose and scope before its controls. The active
pane owns its scrolling within the remaining frame.

On compact screens the two scope groups become separate, horizontally scrolling
navigation rows. Their height stays predictable while the content receives the
remaining viewport space; the dialog and its close action stay within reach in
short windows. Theme choices use visual preview cards that show the writing
surface and navigation together. Accent choices preview their actual product
role, with visible swatches and bounded color controls.

Graph-owned standing queries are authored here with the same query grammar used
elsewhere. Settings owns their graph-level lifecycle; the answer surface owns
how a reader shapes a saved view.

## First Light

Graph opening is a bounded library on the writing surface's neutral canvas.
A faint wash of the reader's accent fades from the top into the neutral canvas.
On wide screens its ordinary catalog footprint sits near the viewport's vertical
center; short and compact screens retain comfortable edge padding. Longer
catalogs grow downward from that anchor rather than recentering the screen.
Repository navigation sits beside one catalog on wide screens and becomes a
horizontal, scrolling tab list on compact screens. Local stays first; remote
locations identify both account and server. Tab orientation and keyboard movement
follow the visible layout. The library's top edge stays fixed during loading and
repository changes.

Quick catalog requests do not flash a loading placeholder. Returning to a
repository preserves its catalog or sign-in surface while it refreshes.

The catalog prioritizes opening existing graphs. An empty catalog explains what
a graph holds and offers creation directly; a populated catalog keeps that action
in its header. Creation opens a dialog with a labeled name field, an example, and
the selected destination. Dismissal returns focus to its initiating action. Archive
import remains a secondary action in the catalog footer and always creates a copy.

A named server-connection action stays alongside repository navigation. The
selected remote account's menu signs out or forgets that account. Remote graph
actions distinguish removing this device's copy from permanent server deletion,
which is available to the graph owner and names its effect on every member. Repository
selection scopes listing, creation, and import together. Browser-wide language
and appearance choices remain available from the masthead before opening a graph.

## Responsive Contract

Responsive changes preserve capability and hierarchy:

- the rail becomes a drawer with a visible close action, Escape dismissal, focus
  containment, and focus return; the writing surface is inert while it is open;
- settings panes stack without mixing their scopes;
- touch targets grow and hover-revealed controls become explicit;
- long-press reaches the same contextual actions as a pointer context menu; and
- overlays remain within the available viewport rather than forcing shell
  scrolling.

Shared control, overlay, and feedback behavior follows
[Interaction](interaction.md); target and keyboard requirements follow
[Accessibility](accessibility.md).
