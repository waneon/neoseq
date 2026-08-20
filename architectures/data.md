# CRDT Data and Local Persistence Architecture

## Canonical Graph

Each graph maps to one Loro document and is an independent storage, export, and
synchronization unit. The document schema is v1 and has three roots:

```text
meta: Map
  graph_id: string
  schema_version: 1
pages: Map<PageId, PageMap>
tags: Map<TagId, TagRecord>
```

The Loro document plus its verified update/checkpoint history is the only
canonical representation. RDF triples, text caches, query plans, and session UI
state are disposable projections. Shared saved-view definitions are canonical
document-property data. There is no migration ledger in the current
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

A property bag maps each validated key to a stable field marker. Atomic fields
own zero or more stable value slots; the marker records type and cardinality so
clearing values preserves an empty field. Atomic values are:

- finite number;
- string;
- page reference;
- checkbox/boolean;
- local date.

Schema-owned document fields instead own a mergeable map below a document slot.
`builtin.query` stores source as `Text` and each stable-ID result view as its own
map, so source edits, view selection, and edits to different views merge without
replacing one serialized object. Removing any property deletes its marker and
all atomic slots or document containers owned by the key.

[`../contracts/property-registry.json`](../contracts/property-registry.json) is
the v2 authority for built-in shapes, semantic ordering, placements, and `user` versus `core`
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

Open chooses the newest checkpoint with the current schema and a valid checksum,
then replays the verified update tail in sequence order. Invalid checkpoints are
quarantined and the next older checkpoint is considered. Once an update tail is
invalid, that record and the remaining tail are quarantined rather than partly
applied. If checkpoints exist but none are valid, open fails explicitly.

Recovery state is one Base checkpoint plus its verified Tail updates. A normal
snapshot retains operation history for interchange. A GC checkpoint is a Loro
shallow snapshot at the current frontier: it preserves current state and the
frontier needed by later updates while discarding operations before that
frontier.

Local-only graphs install a GC checkpoint after 128 Tail records or 512 KiB.
Checkpoint write, covered-update deletion, older-checkpoint deletion, metadata
accounting, and pointer advance are one transaction, so recovery sees either
the old Base+Tail or the new one. Clean close also attempts this maintenance,
but correctness and bounded growth do not depend on close firing.

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

Acknowledgement removes the matching outbox record. A Tail row already covered
by Base remains pinned while referenced and is deleted with that acknowledgement.
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

Pre-release v1 may replace an undeployed encoding destructively without a schema
version bump; superseded snapshots are then unsupported and recreated rather
than migrated. The first post-release document-schema change must define its supported input range,
identity-preserving migration, fixtures captured from deployed data, minimum
writer policy, and rollback behavior in this document. Until then, v1 is the
only accepted schema and unsupported values fail explicitly.

## Verification

- native and browser persistence suites exercise the shared current CorePort corpus;
- restart tests compare semantic graph state after checkpoint plus tail replay;
- fault tests cover before-commit, after-commit, busy/quota, and corrupt records;
- convergence tests exchange binary updates in different and duplicate orders;
- browser outbox tests cover normalized queueing, epoch rebase, restart,
  protocol encoding, and acknowledgement;
- compaction tests cross the periodic threshold and reopen from the retained
  shallow checkpoint and remaining tail;
- generated contracts are synchronized before tests and checked by production builds.
