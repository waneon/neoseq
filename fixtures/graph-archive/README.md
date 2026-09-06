# Schema 6 archive

`schema-6.neoseq` contains synthetic data exported by the schema 6 writer at
commit `1231572d` (the parent of the schema 7 representation change).
It contains no user data.

It covers a regular page, a soft-deleted reference target, a journal, nested
blocks, a deleted block, tag membership and defaults, a tag outline, atomic and
set properties, empty fields, and page/block/tag/default queries with graph-scoped
IRIs. Tests must preserve the existing entity IDs and authored content when
copying it into a new graph under the current schema.
