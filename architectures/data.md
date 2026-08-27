# CRDT Data and Local Persistence Architecture

## Canonical Graph

Each graph maps to one Loro document and is an independent storage, export, and
synchronization unit. The current document schema is v6 and has four roots:

```text
meta: Map
  graph_id: string
  schema_version: 6
  minimum_writer_schema: 6
  applied_migrations: Map<MigrationId, TargetSchema>
pages: Map<PageId, PageMap>
tags: Map<TagId, TagRecord>
graph_settings: Map
  schema_version: 1
  default_queries: Map<DefaultQueryId, DefaultQueryRecord>
```

The Loro document plus its verified update/checkpoint history is the only
canonical representation. RDF triples, text caches, query plans, and session UI
state are disposable projections. Shared query documents are canonical graph
data whether an entity property or graph setting owns them.

Schemas v1 through v5 are migratable predecessors. Recovery replays Base and
Tail, then applies each missing migration as a normal CRDT commit before
persisting a current checkpoint or accepting writes. `0001-lifecycle-metadata`
advances v1 to v2; `0002-tag-outlines` materializes every tag-owned tree and
advances v2 to v3; `0003-graph-settings` adds shared graph configuration and
advances v3 to v4; `0004-independent-query-views` moves each shared query
definition into its stable view and advances v4 to v5; and
`0005-inline-page-references` reserves the semantic inline atom and advances v5
to v6 without interpreting existing Markdown. A contiguous migration
registry selects the next step from the stored version; orchestration has no
version-specific branches. Each step prepares a complete plan by reading only
the source structure it consumes, then applies that plan to a staging document.
The staging document replaces the recovered graph only after the complete chain
and strict current-schema validation succeed. Reopening v6 is a no-op, and
schemas outside `[1, 6]` are rejected without downgrade or coercion.

## Graph Settings

Graph settings are shared configuration whose identity is the graph rather than
an entity. Each live default query is a stable map entry with a title, numeric
position, deletion tombstone, and direct `neoseq.query` document map. The live
list is bounded to eight and ordered by position with ID as a deterministic tie
break. Query-document commands use a distinct `QueryOwner`; page, block, and tag
variants resolve to `builtin.query`, while `graph_default` resolves directly to
this map entry.

## Outline Owners, Nodes, and Ordering

`pages` is keyed by stable `PageId`. Each page contains:

```text
root: NodeData
outline: MovableTree<NodeData>

NodeData
  content: Text
  properties: PropertyBag
  tag_refs: Map<TagId, true>
```

Block `content` encodes semantic page-reference atoms as one reserved character
with a non-expanding Loro text mark. Page roots remain plain text. Domain and
CorePort projections expose the semantic atom rather than this adapter encoding;
see [inline page references](page-references.md).

The page root's content is a regular page title. Journal display titles derive
from `builtin.journal-date`. New journal IDs derive deterministically from graph
ID and date; a portable graph copy keeps existing journal IDs and resolves a day
by that semantic property before deriving an ID.
Regular page names are unique after whitespace normalization and Unicode
lowercasing. Stable IDs, not names, are identity.

Each tag record likewise owns metadata, defaults, and a direct
`outline: MovableTree<NodeData>`. The tag is the owner; there is no backing page,
and placing a block in that tree does not add the tag to the block.
Schema-v2 tag records written before tag outlines existed may omit `outline`.
The v3 migration materializes each missing tree after durable Tail replay. An
existing non-tree value remains invalid rather than being silently replaced.

Every outline node is a block. Its Loro tree ID is the external `BlockId`, and
the containing page or tag tree determines ownership. Indent, outdent, reorder,
and move stay within one owner. Moving content between owners is an explicit
copy with new block IDs.

An Enter split preserves the source block's identity. A leading split inserts
an empty sibling before it; a middle split retains metadata on the head and
creates an unadorned tail; a trailing split creates an empty block after it or
as its first child. A backward merge preserves the previous sibling, appends the
source's rich text and children, and deletes the source identity and metadata.
Structural commands validate the entire proposed change before mutation.

## Tags and Properties

Tags are independent graph entities keyed by `TagId` and have a unique live
name namespace. Page and block `tag_refs` carry membership explicitly. Tag
deletion keeps the tag record as a tombstone but removes its ID from every node
in the same transaction. Snapshot projection exposes only references to live
tags, quarantining stale or concurrently merged dangling IDs.

A property bag maps each validated key to a stable field marker. Atomic fields
own zero or more stable value slots; the marker records type and cardinality so
clearing values preserves an empty field. Atomic values are:

- finite number;
- string;
- page reference;
- checkbox/boolean;
- local date.

Schema-owned document fields instead own a mergeable map below a document slot.
`builtin.query` stores each stable-ID result view as its own map, with a nested
definition whose source is `Text`. Definition and presentation edits therefore
merge within one view without replacing the document or touching sibling views.
Removing any property deletes its marker and all atomic slots or document
containers owned by the key.

[`../contracts/property-registry.json`](../contracts/property-registry.json) is
the v9 authority for built-in shapes, semantic ordering, placements, and `user` versus `core`
access. Every key is `builtin.<lowercase-kebab-name>` or
`user.<lowercase-kebab-name>`. Unknown built-ins are retained read-only so newer
data does not disappear in an older client; unknown user keys remain generic
graph-level properties rather than private per-user metadata.

Adding a tag copies each declared default field, including an empty field, into
properties whose key is absent in the same transaction. Existing fields win,
removing a tag does not remove copied fields, and later default changes are not
retroactive. See [Property fields](properties.md).

Pages, blocks, and tags initialize `builtin.created-at` and
`builtin.updated-at` together. Direct mutation advances `updated-at`; a block
mutation also touches its outline owner. Page and tag deletion sets `builtin.deleted-at`,
and restore clears it. Tag deletion also advances timestamps on nodes and owning
pages whose membership it removes. `created-at` never changes.

## Validation and Merge

The runtime validates these invariants before publishing state:

- the stored graph ID and schema version match the opened graph;
- every visible block is reachable exactly once from its page or tag tree;
- no visible hierarchy cycle exists;
- regular page and tag names are unique in their separate namespaces;
- properties and tag records have valid encodings;
- published page and block tag memberships resolve to live tag records.

Local commands are preflighted against current state. Remote updates are first
applied to a fork and are published only if the merged snapshot passes the same
validation. Loro determines concurrent text, map, and tree merge outcomes;
timestamps are user metadata, not ordering authorities.

## Repository Contract

The core persistence port stores:

```text
GraphMetadata
  graph_id, replica_id, history_epoch, schema_version
  next_sequence, compacted_through, checkpoint/tail byte counts, timestamps
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

## Base+Tail Recovery and Compaction

Open chooses the newest supported checkpoint with a valid checksum, migrates it
when necessary, then replays the verified update tail in sequence order. Invalid
checkpoints are quarantined and the next older checkpoint is considered. Once
an update is invalid or has unresolved causal dependencies, that record and the
remaining Tail form one corrupt suffix. Recovery atomically installs a
checkpoint at the last valid frontier, moves the suffix to quarantine, and
removes it from active history without reusing sequence numbers. If checkpoints
exist but none are valid, open fails explicitly. After recovery, the runtime
establishes a fresh local undo boundary at the accepted frontier.

Recovery state is a Base checkpoint plus its verified Tail updates. A normal
snapshot retains operation history for interchange. A GC checkpoint is a Loro
shallow snapshot at the current frontier: it preserves current state and the
frontier needed by later updates while discarding operations before that
frontier.

Local-only graphs install a GC checkpoint after 128 uncompacted Tail records or
512 KiB. Checkpoint write, retention, Tail deletion, metadata accounting, and pointer
advance are one transaction. Exactly the current and prior Base are retained.
Tail rows covered by the current Base stay for its first generation so the prior
Base remains usable; the next checkpoint reclaims the now-obsolete generation.
Clean close also attempts this maintenance, but correctness does not depend on
close firing.

Remote replicas cannot choose a GC frontier independently. They retain mergeable
history until the server publishes a new `history_epoch`. Adopting that epoch is
one transaction: the server checkpoint becomes Base, durable unacknowledged
intent is replayed and exported against the server version vector as at most one
Tail record, and the outbox references that Tail. If rebase or commit fails, the
old canonical state remains intact.

Quarantine records are not silently deleted or re-imported. The storage UI may
export their opaque bytes by handle without treating them as graph data.

## IndexedDB Adapter

The browser uses database `neoseq-local`, version 3, with six stores:

```text
metadata      key graph_id
updates       key [graph_id, local_sequence], indexes by_graph/by_checksum
checkpoints   key [graph_id, local_sequence], index by_graph
quarantine    key [graph_id, export_handle], index by_graph
outbox        key [graph_id, message_id], index by_graph
sync-state    key graph_id
```

The Worker owns database access. The first open persists a random 53-bit
`replica_id`; later opens reuse it so version vectors do not accumulate a peer
for every browser runtime. Each graph append updates metadata and inserts the
update in one transaction. For a remote graph, that transaction also inserts an
outbox message ID, causal base, and local sequence. Incremental outbox records
reference the update row instead of duplicating its payload. Only the initial
sequence-zero bootstrap stores inline bytes because it has no update row.

Portable import generates a new graph and replica ID outside the archive, then
installs the validated shallow clone as a sequence-zero checkpoint. Metadata and
checkpoint creation share one IndexedDB transaction and require the target graph
to be absent, so an import is either a complete new local graph or no graph.

Acknowledgement removes the matching outbox record. A referenced Tail row stays
pinned until acknowledgement and is deleted only when the fallback Base no
longer needs it.
Storage capability `usage_bytes` reports logical bytes owned by this graph—Base,
Tail, standalone bootstrap, and quarantine—not origin-wide Wasm, font, or HTTP
cache allocation. Browser quota remains the origin quota reported by
StorageManager. A Web Lock allows only one writable tab per graph; another tab
opens read-only.

## SQLite Adapter

The headless native adapter uses one WAL-mode profile database. Schema version 2
contains graph metadata, update, checkpoint, and quarantine tables with the same
stable replica identity, byte accounting, transaction, and checksum behavior as
IndexedDB. Its purpose is native parity,
restart, compaction, corruption, and injected-failure testing until a Tauri shell
is implemented.

## Current Scope and Evolution

Core graph locators contain only `graph_id`. The browser directory separately
records whether a locally persisted replica is local-only or attached to a
remote server. Transport credentials and presence are not canonical state. The
RDF index is rebuilt on open and has no persisted cache.

Any change to the canonical Loro container layout or invariants that would make
an existing supported document fail validation is a document-schema change. It
must increment the schema version in `contracts/graph-schema.json` — the one
declaration the core, the sync boundary, and the browser adapter are generated
from — and ship explicit migration code; readers, commands, and projections must
not repair legacy or missing structure lazily.

Every future document-schema change must define its supported input range,
identity-preserving CRDT migration, deployed-data fixture, minimum-writer policy,
and checkpoint rollback boundary here. Its source reader remains private to the
migration step rather than becoming an alternate runtime reader. Compatibility
is explicit rather than inferred from a current decoder accepting legacy bytes.

## Verification

- native and browser persistence suites exercise the shared current CorePort corpus;
- restart tests compare semantic graph state after checkpoint plus tail replay;
- fault tests cover before-commit, after-commit, busy/quota, and corrupt records;
- convergence tests exchange binary updates in different and duplicate orders;
- browser outbox tests cover normalized queueing, epoch rebase, checkpoint plus
  Tail resync, restart, protocol encoding, and acknowledgement;
- compaction tests cross the periodic threshold and reopen from the retained
  current/prior checkpoints and remaining Tail;
- the checked-in v1 lifecycle and v2 tag-outline fixtures migrate in core,
  browser, native, and server paths and are stable under a second open;
- a v4 graph archive with graph-owned default queries migrates, clones, and
  reopens under a fresh graph identity;
- generated contracts are synchronized before tests and checked by production builds.
