# Query Design Architecture

## Boundary

This boundary governs how a query is authored, presented, shaped into saved
views, and embedded in an outline, tag page, or journal. Query semantics and
execution belong to the core/query architecture; this document owns the
reader-facing question and answer.

## The Answer as an Object

A query answer is a bounded ground within the writing surface. Its inset ground
distinguishes it from authored prose, and its edge makes the whole answer an
object that can be folded, shaped, and acted on. Internal table structure uses
lighter separators so the object does not become a stack of competing bands.

At rest the header states the query's name and result count. The name leads; the
count remains metadata. Where no name exists, the count can lead alone. The
whole header is the folding target, and it reserves disclosure geometry even
when an empty answer has nothing to fold so asynchronous results do not shift the
line.

The machine-readable plan is not repeated permanently above every answer. It is
the accessible name and contextual explanation of the control that opens the
question.

## One Document, Different Contexts

The same query document appears with different disclosure density according to
its role:

- In an outline it behaves like a paragraph that answers itself. Controls are
  contextual and saved views remain in a menu.
- On a tag page it is the body of the page. Saved views become a permanent
  surface instrument.
- Under a journal it is a standing answer authored in graph settings. The
  reader may shape and fold the answer there, but editing the graph-owned
  question routes back to settings.

These contexts do not fork the document or query grammar. They change only which
controls the surface may state permanently and who owns authoring.

## Question and Answer Controls

The query builder edits what the question asks. It reads as a sentence in rows,
with one lead column and groups expressed as depth rather than nested cards. A
row limit is another clause, not an unrelated control bar. Builder state that has
no semantic effect is omitted from storage.

How the answer is read belongs on the answer itself. Layout, sort, visible table
columns, and density are view controls rather than query clauses. There is one
authoring grammar; generated query text may be inspected, but hand-written query
text is not a parallel editor or conversion path.

Builder and folded state are remembered per reader and query. Storage records
departures from the default so untouched graphs do not accumulate presentation
state.

## Saved Views

A query begins with one view named for its contents rather than duplicate views
named after renderer shapes. Layout is a property of a view. A second view is an
independent saved question: it may begin as a copy, but later authoring,
execution, columns, and presentation never alter its siblings.

When multiple views exist, they use the shared segmented-control language: a
recessed track with the current key raised. The track contains states only; the
action to add a view sits beside it. Choosing another tab changes the view;
pressing the current tab opens operations that belong to that view, such as
rename, duplicate, move, and delete.

Tabs keep predictable inner alignment, state their menu disclosure, and wrap so
every view remains visible. Reordering previews a seam and preserves geometry
until commit.

## Table and List Views

Columns are a table concern. The table's column panel adds or removes query
fields and controls their visibility for that view. Repeated fields fold into one
cell; singular fields render directly. Structural bookkeeping and subject counts
are not display columns.

A list has no column-visibility control because it presents entities rather than
a grid; it states the facts returned for each entity using the outline's content
language.

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
renderers own only their ink and inline decoration. Compact density changes one
row-height token rather than selecting alternate renderer rules. Secondary
actions overlay the frame without changing the value's geometry. Interaction
paint never leaves that frame: pointer and edit states use a contained fill,
while keyboard focus alone adds an inset ring. Grid separators are independent
and consistently belong to the preceding row's bottom edge.

## Standing Answers

Journal standing answers begin after the outline's append region. They need no
additional enclosing heading or separator because each answer already has a
name and boundary. Spacing treats each answer as a section rather than another
result row.

A standing answer may expose reading actions, saved-view shaping, folding, and
editing of the blocks it quotes. It does not imply that the journal owns the
question. The route to edit the question names and opens its graph-settings
owner.

Shared control, drag, and overlay behavior follows
[Interaction](interaction.md); result editing retains the cross-surface metadata
identity defined in [Metadata](metadata.md).
