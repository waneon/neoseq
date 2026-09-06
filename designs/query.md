# Query Design Architecture

## Boundary

This boundary governs how a query is authored, presented, shaped into saved
views, and embedded in an outline, tag page, or journal. Query semantics and
execution belong to the core/query architecture; this document owns the
reader-facing question and answer.

## Question and Answer Hierarchy

A query is a bounded surface with a clear question above its answer. Its ground
and edge distinguish derived results from authored prose; internal separators
express sections without competing with that boundary.

The header leads with the query's name, falling back to its subject when unnamed.
When the builder is closed, a short visible condition summary explains what the
question asks. A labeled conditions control makes authoring discoverable and
states whether the builder is open.

A separate answer toolbar owns the result count and folding control, the current
Table or List layout, Columns, and Sort. Labels explain actions; counts identify
the applied conditions and ordering. Empty answers retain stable
header geometry and offer a concise hint for adjusting the question. Recovery
actions respect the surface's authoring authority.

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

The query builder separates the source, its conditions, and the returned answer.
A source header states which entities to search. Consistent filter rows make
field, comparison, and value recognizable as controls; depth expresses nested
condition groups. Adding a condition is the primary action within that section.
A quieter footer holds result grain and row limit. Builder state that has no
semantic effect is omitted from storage.

The question explicitly returns entities or a summary. An entity answer has one
row per selected thing; a summary states its grouping fields and scalar
aggregates and is read-only. These are different questions, so their choice
belongs in the builder. Repeated entity fields need no aggregation control.

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

Saved views use the shared segmented-control language: a recessed track with the
current key raised. The track appears permanently on a page and whenever an
inline query has multiple views. It contains states only; a visible action to
add a view sits beside it. Choosing another tab changes the view; pressing the
current tab opens operations for that view, such as rename, duplicate, move, and
delete.

Tabs keep predictable inner alignment, state their menu disclosure, and wrap so
every view remains visible. Reordering previews a seam and preserves geometry
until commit. A surface that cannot manage views exposes selection without
management actions.

## Table and List Views

Table and List are two readings of the same answer. Switching layout preserves
the selected entities or summary groups. Entity table columns add or remove
display fields and control their visibility for that view; repeated values share
one cell and retain their individual references. Column choices do not change
the answer's membership or row count. Summary fields and aggregates belong to
the question; structural bookkeeping is not an entity display column.

An entity block list has no column-visibility control because it presents blocks
using the outline's content language. Summary and other result lists present
their returned fields without becoming editable blocks.

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
quiet. Cells align within the full row rather than hanging from its top. List
rows hang from a content indent; table rules span the object because grid
structure, unlike outline hierarchy, depends on full-width tracks.

Every table value inhabits the same cell frame. The table owns that frame's row
height, padding, typography, clipping, and interaction state; semantic
renderers own their meaning-bearing weight, tracking, numeric shape, ink, and
inline decoration. A surface may change scale, density, or affordance, but the
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
Conditions disclosure is shared with its Settings editor; authoring the definition
remains in Settings. It does not imply that the journal owns the
question. The route to edit the question names and opens its graph-settings
owner.

Shared control, drag, and overlay behavior follows
[Interaction](interaction.md); result editing retains the cross-surface metadata
identity defined in [Metadata](metadata.md).
