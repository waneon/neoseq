# Inline Page Reference Architecture

## Boundary

An inline page reference is a semantic atom inside collaborative block content.
Its identity is a stable `PageId`; a page title is never duplicated into the
canonical block. `[[current title]]` is the shared editor, reading, query, and
clipboard projection of that atom.

The domain content model is an ordered sequence of Markdown text and page
reference atoms. The Loro adapter encodes a reference as one object-replacement
character carrying a non-expanding `neoseq.page-reference` text mark. That
encoding never crosses CorePort. Plain authored `[[text]]` has no graph meaning
until an explicit completion resolves it.

## Projection

Graph summaries expose a page directory containing live and deleted page IDs,
titles, journal dates, and lifecycle state. A block snapshot carries semantic
content. Materialized Markdown and reference spans are disposable reader
projections, mapping each displayed token to its one canonical logical position. Changing a page
title therefore changes only the directory; mounted references immediately
materialize the new title without mutating their blocks.
Journals use their ISO local date as this shared, locale-independent title;
presentation surfaces may format the separate directory date for other UI.
Snapshot title resolution follows the same date rule, including property page
pickers and previews, so live journals never fall back to their internal IDs.

Editor projection maps browser UTF-16 offsets to canonical logical offsets.
Unicode scalar values and reference atoms each occupy one logical position.
Editing through a displayed reference demotes that atom to its current
`[[title]]` source before applying the text edit. Choosing a page completion
replaces the typed source with one atom. Untouched references survive ordinary
text edits, splits, synchronization, and title changes.

The completion list uses the same token-origin caret anchor as slash and tag
completion. Its replacement span may include an existing `]]`, but that span and
the visual anchor offset are separate values: editing semantics cannot move the
overlay, and placement cannot change what accepting a reference replaces.

## Commands and Consistency

`splice_block_content` accepts a bounded sequence of Markdown and page-reference
insertions in logical coordinates. Creating a page and inserting its reference
uses one flat batch. The core validates the complete splice and page targets
before applying one Loro transaction and history item. The plural content splice
accepts ordered edits, including multiple edits to one block; each range is
validated against the preceding edits before the transaction applies.

Reference marks use `ExpandType::None`. A valid mark covers exactly one reserved
object-replacement character and carries one valid `PageId`. Invalid remote or
forward data is quarantined and never becomes a reference projection or query
fact. The current schema requires every writer to preserve the reserved atom;
this representation was introduced in schema v6 and remains part of schema v7.

## Derived Consumers

The Markdown renderer transforms only declared reference spans into internal
links. Full block projections navigate; compact table projections remain
phrasing-only. Deleted targets retain their stable route and last directory
title, while missing targets fall back to their ID. Completion offers only live
targets.

The RDF index emits `<block> neo:references <page>` and materializes
`neo:content` with the current title. A title change invalidates that disposable
projection as one unit; canonical blocks are never rewritten. The reference
edges form the boundary for a future incremental reverse ledger if rename
rebuild cost becomes material.

Page and tag surfaces expose incoming links through the session-scoped query
execution cache. Page links include semantic inline atoms and typed page
properties; tag links include explicit attachments on pages and blocks.
Structural ownership and unresolved text do not count as links. The disposable
RDF index finds sources across unloaded outlines, and its entity references
provide canonical navigation. References refresh with graph revisions and are
never stored as authored queries. Bounded result pages stay below the query row
budget, retain the previous answer while loading, and allow returning after an
empty or failed page. Counts describe only a complete first page or its lower
bound. Source previews remain read-only; an explicit block button handles
navigation without turning keyboard focus into a route change.

`neoseq.outline` v2 carries page-reference spans and descriptors. Same-graph
paste keeps IDs; cross-graph paste resolves journals by date and regular pages
by normalized title before creating target-local identities. Standard Markdown
and HTML exports contain readable current titles, not internal IDs.
