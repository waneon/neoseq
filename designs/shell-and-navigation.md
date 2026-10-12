# Shell and Navigation Design Architecture

## Boundary

The shell places the reader in the graph. It owns the rail, the top bar, the
place directories, the command entrance, settings, and the graph library.
Document bodies and their contextual controls belong to their focused areas.

## Spatial Model

The frame has one navigation region and one content region. The content region
scrolls; the frame does not. On wide screens the rail is a collapsible column.
On narrow screens a bottom bar offers Journal, Search, New page, and Library;
Library opens the rail as a focus-contained drawer (full screen on phones).
Closed navigation cannot receive focus. While a block is being written on a
phone, structural actions and Done replace the bottom bar. Shell and overlays
share the visible viewport so the software keyboard never covers the
interaction.

## Rail

The rail is scanned, not read: dense rows, one quiet ground, small chrome type.

- **Head:** the product mark and graph name open the graph menu (rename,
  settings, members, all graphs). A shared graph carries a remote mark. The
  collapse control sits beside it.
- **Verbs:** Search keeps the shape of the action it opens and shows its
  shortcut; New page creates and opens an untitled page. Both are disabled for
  read-only graphs where they would write.
- **Places:** Journal, Pages, and Tags, with page and tag totals.
- **Favourites:** pages and tags the graph keeps at hand, in the graph's own
  order, with drag and keyboard reordering. Absent when empty.
- **Recent:** documents this browser opened most recently, excluding
  favourites. Absent when empty.
- **Foot:** Settings, and the keyboard reference on pointer devices.

The current place uses a raised neutral key with an accent mark. Journal stays
current on every dated journal route.

## Place Directories

Pages and Tags are directories with the same frame: the title and total, a
filter field, and a quiet table whose names hold the left edge and whose figures
align under named columns. Pages are sorted by name, incoming links, or
creation; the tag library adds groups, marks, usage counts, and ordering (see
[Metadata](metadata.md)). Creation lives in the top bar. Empty and unmatched
lists state the fact and offer the next action.

## Top Bar

The top bar carries what applies to the current document wherever the reader
has scrolled:

- browser Back and Forward on wide screens;
- the name of the document or journal day whose header has scrolled away;
- save, sync, and read-only status only when not healthy;
- the document's own controls, rendered by the document into the bar
  (favourite, customization, actions menu, directory creation);
- Undo and Redo.

On narrow screens the graph name replaces Back, Forward, and the scrolled name.

## Commands

Permanent chrome is small. A secondary control may be hidden at rest only when
hover and focus reveal it, touch reaches it, and the command layer offers it.

One registry owns labels, availability, bindings, disabled reasons, execution,
and a pointer route for every command. One arbitration order handles IME
composition, the topmost overlay, editor commands, and global commands. Global
shortcuts never take unmodified typing keys from text fields.

The command palette is the global entrance. With no query it previews places
and actions. With a query it lists, in order: a matching journal date, matching
pages (with Create page as the last page row), tags, block matches placed by
their document, then actions. A scattered match must start at a word. The frame
keeps a stable size, rows hold one line, and closing restores the prior caret.
Touch screens add an explicit close action.

## Settings

Settings is a dialog addressed by the URL, so Back closes it. Its index groups
sections for this browser and for this graph; each pane opens with its name and
explains only what is not self-evident. Phones show the index and one section at
a time with a permanent back action. Theme choices preview the product; accent
choices preview their role. Graph-owned standing queries are authored here with
the shared query grammar.

## Graph Library

Opening a graph is one column on the neutral canvas: the product mark and
browser preferences, the Graphs heading with New graph, the graph list (name,
role, creation, offline availability, and an actions menu), and a footer with
Import and Connect a server that holds the window's foot, so switching
locations moves only the list. Locations become tabs above the list once more than
one exists; Local stays first and remote tabs name account and server. Quick
catalog requests show no placeholder; a slow one reserves rows.

Creation opens a dialog with a labeled name and the destination it will be saved
to. Import always creates a copy. Remote graph actions distinguish removing this
device's copy from server deletion, which only an owner sees.

## Responsive Contract

- The drawer has a close action, Escape dismissal, focus containment, and focus
  return; the document is inert while it is open.
- Touch targets grow to 44px; hover-revealed controls gain a touch route.
- Long-press reaches the same actions as a context menu.
- Overlays stay within the visible viewport.

Shared control and overlay behavior follows [Interaction](interaction.md);
target and keyboard requirements follow [Accessibility](accessibility.md).
