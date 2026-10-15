# Query Design Architecture

## Boundary

This boundary governs how a query is authored, presented, shaped into saved
views, and embedded in an outline, tag page, or journal. Query semantics and
execution belong to the core/query architecture; this document owns the
reader-facing question and answer.

## Question and Answer Hierarchy

A query is a derived answer inside writing. In an outline it has one hairline
frame and no inner bands; on a tag page it is the page's body and drops the
frame. One header row holds the question on the left and the reading tools on
the right:

- the name, falling back to its subject (`Blocks`);
- the question itself, a compact summary of its conditions that opens and
  closes the builder and states whether it is open;
- the result count, which folds the answer when there is one to fold;
- Columns, Sort, and Layout as labeled icon tools;
- the query's actions menu.

Empty answers keep the header's geometry and offer a concise route to adjust
the question. Recovery actions respect the surface's authoring authority. A
block that holds a query keeps its own line as the query's caption, shown as a
placeholder while empty.

## One Document, Different Contexts

The same query document appears with different disclosure density according to
its role:

- In an outline it behaves like a paragraph that answers itself. A single view
  stays compact, with creation of another view in the actions menu. Multiple
  views expose their shared tab strip.
- On a tag page it is the body of the page. Saved views become a permanent
  surface instrument.
- Under a journal it is a standing answer authored in graph settings. The
  reader may shape and fold the answer there, but editing the graph-owned
  question routes back to settings.

These contexts do not fork the document or query grammar. They change only which
controls the surface may state permanently and who owns authoring.

## Question and Answer Controls

The query builder reads as a sentence: `Find [subject]`, its filters, then
`Show up to [limit]`. Each filter is one phrase — field, comparison, and
value, written as the caption writes them — and pressing it opens an editor for
that filter alone; one just added opens on its value. The word before each
filter is how it combines (`where`, `and`, `or`, or `none of` before an
excluding group's first filter), and choosing that word changes how the whole
group combines. A nested group is an inset clause with its own words and a menu
for its combination and removal. `Add filter` is the primary action: a searchable
list of the subject's fields, ending in a filter group. Removal is present at
the hand beside each phrase. Builder state that has no semantic effect is
omitted from storage.

A question returns entities, one row per selected thing. Repeated fields share
one cell; there is no aggregation.

How the answer is read belongs on its toolbar. The labeled layout menu selects
Table or List and holds density and wrapping preferences. Columns and Sort have
their own labeled controls. These presentation choices remain separate from the
query clauses. There is one authoring grammar; generated query text may be
inspected, but hand-written query text is not a parallel editor or conversion
path.

Conditions disclosure is shared state on each saved view. Opening or closing it
persists with the query and follows synchronization and undo/redo. An untouched
view uses the surface's initial default; explicit closure remains closed even
when the query has no conditions. Read-only graphs allow temporary inspection.
Answer folding remains a browser-local reading preference.

## Saved Views

A query begins with one view named for its contents rather than duplicate views
named after renderer shapes. Layout is a property of a view. A second view is an
independent saved question: it may begin as a copy, but later authoring,
execution, columns, and presentation never alter its siblings.

Saved views are tabs over one answer; the current tab is underlined in the
accent. The tabs
appear permanently on a page and whenever an inline query has multiple views.
They contain views only; a visible action to add a view sits beside them. Choosing another tab changes the view; pressing the
current tab opens operations for that view, such as rename, duplicate, move, and
delete.

Tabs keep predictable inner alignment, state their menu disclosure, and wrap so
every view remains visible. Reordering previews a seam and preserves geometry
until commit. A surface that cannot manage views exposes selection without
management actions.

## Table and List Views

Table and List are two readings of the same answer. Switching layout preserves
the selected entities. Entity table columns add or remove
display fields and control their visibility for that view; repeated values share
one cell and retain their individual references. Column choices do not change
the answer's membership or row count. Structural bookkeeping is not an entity
display column.

An entity block list has no column-visibility control because it presents blocks
using the outline's content language. Page, tag, and hand-written result lists
present their returned fields without becoming editable blocks.

An answer may remain visible while a changed question runs. Its labels, value
meaning, and editing authority continue to describe the execution that produced
it until the replacement arrives. A newer draft never changes the meaning of
older visible values.

Changing the question's returned fields, switching saved questions, or folding
an edited answer settles the active result edit first. A failed save leaves that
edit available for retry. A remotely changed answer waits to replace an
incompatible active editor until the edit closes; its visible values keep their
original meaning throughout. An active row remains available if its edit makes
it stop matching, and leaves after the editor closes.

Tables initially share available width. Once the reader resizes a column, all
visible columns adopt the geometry already on screen before the drag continues,
so the first movement causes no jump. Saved view data owns its query fields,
layout, sort, column order, visibility, and explicit widths.

Result cells quote writing and therefore use content ink, while headers remain
quiet. Cells align within the full row rather than hanging from its top. Both
layouts open on a hairline. List bullets start where the header's words do and
keep the outline's slot; table rules span the object because grid structure,
unlike outline hierarchy, depends on full-width tracks.

Every table value inhabits the same cell frame. The table owns that frame's row
height, padding, typography, clipping, and interaction state; semantic
renderers own their meaning-bearing weight, tracking, numeric shape, ink, and
inline decoration. Each value groups its glyph and writing around that frame's
center; a nested reference inherits the value's line height instead of imposing
another control height. A surface may change scale, density, or affordance, but the
same value must not appear to change typeface when projected into a cell.
Compact density changes one row-height token rather than selecting alternate
renderer rules. Secondary actions overlay the frame without changing the
value's geometry. Interaction paint never leaves that frame: pointer and edit
states use a contained fill, while keyboard focus alone adds an inset ring. Grid
separators are independent and consistently belong to the preceding row's
bottom edge.

Content cells never own a horizontal scrollbar. Reading follows the view's wrap
preference and marks clipped text with an ellipsis without introducing a cell
scrollport. Inline editing always wraps, including unbroken text, and grows to
a bounded height before allowing vertical scrolling. Scrollbar space stays
clear of the writing. Entering or leaving editing and changing the wrap
preference reflows the value without changing column widths; leaving editing
restores the reading geometry and shows the beginning of the content.

Markdown links and stable page references remain interactive in both layouts.
Opening a result block uses a separate control and briefly highlights its
destination after navigation; reduced motion uses a stationary highlight.

## Standing Answers

Journal standing answers begin after the outline's append region. They need no
additional enclosing heading or separator because each answer already has a
name and boundary. Spacing treats each answer as a section rather than another
result row.

A standing answer exposes its conditions for inspection as well as reading
actions, saved-view shaping, folding, and editing of the blocks it quotes.
Folding those conditions belongs to the journal; the Settings editor always lays
them out, because authoring the definition remains in Settings. Disclosure does
not imply that the journal owns the question. The route to edit the question names and opens its graph-settings
owner.

Shared control, drag, and overlay behavior follows
[Interaction](interaction.md); result editing retains the cross-surface metadata
identity defined in [Metadata](metadata.md).
