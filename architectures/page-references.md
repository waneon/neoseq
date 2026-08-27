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
titles, journal dates, and lifecycle state. A block snapshot keeps its
materialized Markdown for existing readers and adds reference spans that map
each displayed token to its one canonical logical position. Changing a page
title therefore changes only the directory; mounted references immediately
materialize the new title without mutating their blocks.
Journals use their ISO local date as this shared, locale-independent title;
presentation surfaces may format the separate directory date for other UI.

Editor projection maps browser UTF-16 offsets to canonical logical offsets.
Unicode scalar values and reference atoms each occupy one logical position.
Editing through a displayed reference demotes that atom to its current
`[[title]]` source before applying the text edit. Choosing a page completion
replaces the typed source with one atom. Untouched references survive ordinary
text edits, splits, synchronization, and title changes.

## Commands and Consistency

`splice_block_content` accepts a bounded sequence of Markdown and page-reference
insertions in logical coordinates. Creating a page and inserting its reference
uses one flat batch. The core validates the complete splice and page targets
before applying one Loro transaction and history item.

Reference marks use `ExpandType::None`. A valid mark covers exactly one reserved
object-replacement character and carries one valid `PageId`. Invalid remote or
forward data is quarantined and never becomes a reference projection or query
fact. Schema v6 prevents older writers from treating the reserved atom as plain
Markdown; the v5 migration does not infer references from existing text.

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

`neoseq.outline` v2 carries page-reference spans and descriptors. Same-graph
paste keeps IDs; cross-graph paste resolves journals by date and regular pages
by normalized title before creating target-local identities. Standard Markdown
and HTML exports contain readable current titles, not internal IDs.
