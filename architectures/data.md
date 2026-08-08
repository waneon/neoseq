# CRDT Data and Local Persistence Architecture

## Canonical Graph

Each graph maps to one Loro document and is an independent storage, export, and
future synchronization unit. The document schema is v1 and has three roots:

```text
meta: Map
  graph_id: string
  schema_version: 1
pages: Map<PageId, PageMap>
tags: Map<TagId, TagRecord>
```

The Loro document plus its verified update/checkpoint history is the only
canonical representation. RDF triples, text caches, query plans, and UI state
are disposable projections. There is no migration ledger in the current
document; Step 9 introduces migration metadata alongside the first real schema
transition.

## Pages, Nodes, and Ordering

`pages` is keyed by stable `PageId`. Each page contains:

```text
root: NodeData
outline: MovableTree<NodeData>

NodeData
  content: Text
  properties: PropertyBag
  tag_refs: Map<TagId, true>
```

The page root's content is a regular page title. Journal display titles derive
from `builtin.journal-date`; journal IDs derive deterministically from graph ID and date.
Regular page names are unique after whitespace normalization and Unicode
lowercasing. Stable IDs, not names, are identity.

Every outline node is a block. Its Loro tree ID is the external `BlockId`, and
the containing page tree determines ownership. Indent, outdent, reorder, and
move stay within a page. Moving content between pages is an explicit copy with
new block IDs.

An Enter split preserves the source block's identity. A leading split inserts
an empty sibling before it; a middle split retains metadata on the head and
creates an unadorned tail; a trailing split creates an empty block after it or
as its first child. Structural commands validate the entire proposed change
before mutation.

## Tags and Properties

Tags are independent graph entities keyed by `TagId` and have a unique live
name namespace. Page and block `tag_refs` carry membership explicitly. Tag
deletion keeps the tag record as a tombstone but removes its ID from every node
in the same transaction. Snapshot projection exposes only references to live
tags, quarantining stale or concurrently merged dangling IDs.

A property bag maps a validated key to one stable slot or an ordered set of
stable slots. Each slot contains one tagged scalar:

- finite number;
- string;
- page reference;
- checkbox/boolean;
- local date.

[`../contracts/property-registry.json`](../contracts/property-registry.json) is
the v1 authority for built-in shapes, placements, and `user` versus `core`
access. Every key is `builtin.<lowercase-kebab-name>` or
`user.<lowercase-kebab-name>`. Unknown built-ins are retained read-only so newer
data does not disappear in an older client; unknown user keys remain generic
graph-level properties rather than private per-user metadata.

Adding a tag copies its declared defaults into properties that are absent in
the same transaction. Existing values win, removing a tag does not remove
copied values, and later default changes are not retroactive.

Pages, blocks, and tags initialize `builtin.created-at` and
`builtin.updated-at` together. Direct mutation advances `updated-at`; a block
mutation also touches its page. Page and tag deletion sets `builtin.deleted-at`,
and restore clears it. Tag deletion also advances timestamps on nodes and owning
pages whose membership it removes. `created-at` never changes.

## Validation and Merge

The runtime validates these invariants before publishing state:

- the stored graph ID and schema version match the opened graph;
- every visible block is reachable exactly once from its page tree;
- no visible hierarchy cycle exists;
- regular page and tag names are unique in their separate namespaces;
- properties and tag records have valid encodings.
- published page and block tag memberships resolve to live tag records.

Local commands are preflighted against current state. Remote updates are first
applied to a fork and are published only if the merged snapshot passes the same
validation. Loro determines concurrent text, map, and tree merge outcomes;
timestamps are user metadata, not ordering authorities.

## Repository Contract

The core persistence port stores:

```text
GraphMetadata
  graph_id, schema_version, next_sequence, compacted_through, timestamps
UpdateRecord
  local_sequence, checksum, bytes, created_at
CheckpointRecord
  local_sequence, schema_version, checksum, bytes, created_at
QuarantineRecord
  export_handle, kind, sequence, checksum, reason, bytes, created_at
```

Appending an update and advancing `next_sequence` is one storage transaction.
The SHA-256 checksum is also an idempotency key: retrying exact bytes after an
ambiguous after-commit failure returns the prior sequence instead of duplicating
the update.

A successful core mutation remains pending until append commits. While pending,
the runtime rejects another mutation and clean close; retry uses the same bytes.
Only after commit does it publish semantic and saved events.

## Recovery and Compaction

Open chooses the newest checkpoint with the current schema and a valid checksum,
then replays the verified update tail in sequence order. Invalid checkpoints are
quarantined and the next older checkpoint is considered. Once an update tail is
invalid, that record and the remaining tail are quarantined rather than partly
applied. If checkpoints exist but none are valid, open fails explicitly.

Checkpoint creation stores a full Loro snapshot at a local sequence. Compaction
keeps the selected checkpoint, removes covered updates and older checkpoints,
and advances `compacted_through`. Crash safety comes from transaction boundaries:
either the pre-compaction history or the compacted history remains readable.

Quarantine records are not silently deleted or re-imported. The storage UI may
export their opaque bytes by handle without treating them as graph data.

## IndexedDB Adapter

The browser uses database `neoseq-local`, version 1, with four stores:

```text
metadata      key graph_id
updates       key [graph_id, local_sequence], indexes by_graph/by_checksum
checkpoints   key [graph_id, local_sequence], index by_graph
quarantine    key [graph_id, export_handle], index by_graph
```

The Worker owns database access. Each graph append updates metadata and inserts
the update in one transaction. Browser storage capabilities expose persistence
permission and quota estimates without changing graph semantics. A Web Lock
allows only one writable tab per graph; another tab opens read-only.

## SQLite Adapter

The headless native adapter uses one WAL-mode profile database. Schema version 1
contains graph metadata, update, checkpoint, and quarantine tables with the same
transaction and checksum behavior as IndexedDB. Its purpose is native parity,
restart, compaction, corruption, and injected-failure testing until a Tauri shell
is implemented.

## Current Scope and Evolution

All graph locators are local and contain only `graph_id`. Remote identity,
outboxes, acknowledgements, and transport state enter with remote collaboration,
not as inactive local-storage columns. The RDF index is rebuilt on open and has
no persisted cache.

The first real document-schema change must define its supported input range,
identity-preserving migration, fixtures captured from deployed data, minimum
writer policy, and rollback behavior in this document. Until then, v1 is the
only accepted schema and unsupported values fail explicitly.

## Verification

- native and browser persistence suites exercise the shared current CorePort corpus;
- restart tests compare semantic graph state after checkpoint plus tail replay;
- fault tests cover before-commit, after-commit, busy/quota, and corrupt records;
- convergence tests exchange binary updates in different and duplicate orders;
- compaction tests reopen from the retained checkpoint and remaining tail;
- generated contract drift and schema constants are checked in CI.
