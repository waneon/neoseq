# CRDT Data and Local Persistence Architecture

## Canonical Graph

Each graph maps to one Loro document and is an independent storage, export, and
synchronization unit. The current writer schema is v8. New documents have three roots:

```text
meta: Map { graph_id, schema_version }
entities: Map<DocumentId, DocumentRecord>
graph_settings: Map { schema_version, default_queries }

DocumentRecord
  kind: page | tag
  root: NodeData
  outline: MovableTree<NodeData>
  defaults: PropertyBag
```

The Loro document and its verified checkpoint/Tail history are canonical. RDF,
search indexes, summaries, and UI state are disposable projections. A document
has one authoritative name, property bag, and outline. Page/tag DTO variants
remain presentation and command aliases for the same stable ID.

Readers support schema 7 and 8. Existing schema-7 `pages` and `tags` container
homes remain valid and are read in place, preserving tree IDs and offline causal
history. Their original home supplies the kind until an explicit conversion
writes it. New entities always use the common root. The first subsequent local
command records schema 8 in the same durable update; opening a replica does not
invent migration operations. Recovery checkpoints retain history when upgrading
storage metadata. Live synchronization requires writer schema 8 on both ends.
Portable archive import also retains its explicit schema-6 property conversion.

## Graph Settings

Graph settings are shared configuration whose identity is the graph rather than
an entity. Each live default query is a stable map entry with a title, numeric
position, deletion tombstone, and direct `neoseq.query` document map. Local
creation admits at most eight live entries. Concurrent branches may exceed that
number: every entry remains canonical, while projection publishes the first
eight in `(position, id)` order and reports the remainder as a typed conflict.
Deleting an earlier entry promotes the next one deterministically.
Query-document commands use a distinct `QueryOwner`; page, block, and tag
variants resolve to `builtin.query`, while `graph_default` resolves directly to
this map entry.

## Outline Owners, Nodes, and Ordering

Documents are keyed by stable IDs. Their shared writing structure is:

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
Local commands keep regular page and tag names unique in one namespace after
whitespace normalization and Unicode lowercasing. IDs remain identity. Legacy
and concurrent duplicate names preserve all documents and publish one typed
conflict with the participating IDs; resolving it requires an ordinary rename.

A tag is the same document with tag behavior enabled. Its existing outline is
its notes, and placing a block there does not classify that block. Conversion
preserves the outline container and every block ID. A missing or non-tree outline
is invalid rather than silently repaired.

Every outline node is a block. Its Loro tree ID is the external `BlockId`, and
the containing page or tag tree determines ownership. Indent, outdent, reorder,
and move stay within one owner. Moving content between owners is an explicit
copy with new block IDs.

A deleted tree identity may survive after snapshot compaction has collected all
of its metadata. Such an empty tombstone is valid. A live node still requires
complete metadata, and any resurrection must pass that validation again.

An Enter split preserves the source block's identity. A leading split inserts
an empty sibling before it; a middle split retains metadata on the head and
creates an unadorned tail; a trailing split creates an empty block after it or
as its first child. A backward merge preserves the previous sibling, appends the
source's rich text and children, and deletes the source identity and metadata.
Structural commands validate the entire proposed change before mutation.

## Tags and Properties

Tag references carry document IDs; page and block `tag_refs` record classification
explicitly. Adding a membership requires an active tag. Converting to a page
retains existing memberships and defaults, disables new attachment, and leaves
previously materialized properties untouched. Converting back re-enables defaults.
Journal identity remains date-based and cannot be converted. Tag
deletion keeps the tag record as a tombstone but removes its ID from every node
in the same transaction. Snapshot projection exposes only references to live documents, including former
tags, and quarantines dangling IDs.

A property bag maps each validated key to one regular Loro map. This child is a
field generation: its immutable shape records type and cardinality, while its
shape-specific payload preserves an empty field even when it contains no value.
Atomic values are:

- finite number;
- string;
- page reference;
- checkbox/boolean;
- local date.

Each field child contains `shape` and exactly the corresponding payload: an
optional atomic `single`, a mergeable `set` map keyed by value identity, or a
schema-owned mergeable `document` map. `builtin.query` stores each stable-ID
result view as its own map below `document`, with a nested definition whose
source is `Text`. Definition and presentation edits therefore merge within one
view without replacing the field generation or touching sibling views.

The outer property entry is the sole presence and generation authority.
Removing a property deletes only that reference, so concurrent operations on
the detached child are inert. Recreation inserts a fresh child and cannot expose
payload from the removed generation. If replicas concurrently create an absent
key, same-key regular-container arbitration chooses one complete child—shape
and initial payload—rather than combining them. This also means same-shape first
creations do not union their initial values; fine-grained payload edits merge
only after a generation is shared.

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

The runtime validates these structural invariants before publishing state:

- the stored graph ID and schema version match the opened graph;
- every visible block is reachable exactly once from its page or tag tree;
- no visible hierarchy cycle exists;
- page and tag names have readable representations;
- properties and tag records have valid encodings;
- published classification memberships resolve to live document records.

Local commands additionally enforce semantic and admission constraints such as
name uniqueness and bounded collection creation. Remote updates are first
applied to a fork and are published when the merged document remains
structurally readable. Merge-reachable aggregate disagreements are normalized
by deterministic projection and exposed as typed `GraphConflict` values; they
are not remote-update failures. Loro determines concurrent text, map, and tree
merge outcomes; timestamps are user metadata, not ordering authorities.

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

For a remote Tail record, this same lowercase 64-hex digest is its outbox key and
the sync `message_id`; there is no independently generated transport UUID.

A successful core mutation remains pending until append commits. While pending,
the runtime rejects another mutation and clean close; retry uses the same bytes.
Only after commit does it publish semantic and saved events.

## Base+Tail Recovery and Compaction

Open chooses the newest supported checkpoint with a valid checksum and reads
only Tail records whose compound key follows that Base. The normal path stages
the checksummed Tail in sequence order, then validates the completed document
once. A failed stage or final validation discards that document and
replays from the same Base through the record-validating path, preserving the
exact last valid frontier. Invalid checkpoints are quarantined and the next
older checkpoint is considered. Once an update is invalid or has unresolved
causal dependencies, that record and the remaining Tail form one corrupt suffix.
Recovery atomically installs a checkpoint at the last valid frontier, moves the
suffix to quarantine, and removes it from active history without reusing sequence
numbers. If checkpoints exist but none are valid, open fails explicitly. After
recovery, the runtime establishes a fresh local undo boundary at the accepted
frontier.

Recovery state is a Base checkpoint plus its verified Tail updates. A normal
snapshot retains operation history for interchange. A GC checkpoint is a Loro
shallow snapshot at the current frontier: it preserves current state and the
frontier needed by later updates while discarding operations before that
frontier.

Local-only graphs install a GC checkpoint after 128 uncompacted Tail records or
512 KiB. Checkpoint write, retention, Tail deletion, metadata accounting, and pointer
advance are one transaction. Exactly the current and prior Base are retained.
The metadata Tail counters describe only updates newer than the current Base;
rows retained solely for the prior Base's fallback generation do not trigger
another compaction.
Tail rows covered by the current Base stay for its first generation so the prior
Base remains usable; the next checkpoint reclaims the now-obsolete generation.
Metadata reads, snapshot export, and checkpoint installation in this maintenance
path are best effort after append; their failure never changes an already durable
command into a rejected response. Clean close also attempts maintenance, but
correctness does not depend on close firing.

Remote replicas use the same checkpoint and Tail retention mechanism with a
snapshot that preserves causal history. Unacknowledged outbox entries pin their
exact Tail payloads until server acknowledgement, even after both retained
checkpoints cover them. Compaction preserves the live core, undo, epoch, and
server provenance. Received bulk snapshots are durable imports into that core.

The `sync-state` record distinguishes an arbitrary local checkpoint from a
server-approved Base. Sync configuration does not create an update. A replica
without the marker installs its initial server checkpoint before it can mutate;
checkpoint, epoch and provenance commit atomically. A based replica or one with
pending outbox work refuses replacement and retains its exact local state for
recovery. History truncation and replay across incompatible epochs are not part
of ordinary synchronization.

Quarantine records are not silently deleted or re-imported. The storage UI may
export their opaque bytes by handle without treating them as graph data.

## IndexedDB Adapter

The browser uses database `neoseq-local-v1`, version 1, with six stores:

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
for every browser runtime. Metadata records carry the repository-qualified
locator. Legacy records without one are read as local without rewriting their
physical keys. Recovery selects Tail rows with the
`[graph_id, local_sequence]` primary
key range after the chosen Base rather than loading graph history and filtering
it in memory. Each graph append updates metadata and inserts the update in one
transaction. For a remote graph, that transaction also inserts the update
checksum as the outbox `message_id`, together with its causal base and local
sequence. Incremental outbox records reference the
update row instead of duplicating its payload. There is no sequence-zero
bootstrap: initial remote state is installed as a server-approved Base, not
transported as an update.

Opening a graph verifies each referenced Tail checksum against its payload.
Before exposing the graph, a serialized write transaction rechecks and rewrites
pending records from the preceding protocol generation from their arbitrary
transport ID to that checksum. A concurrent acknowledgement or replacement
cannot be resurrected, and no unverified record can cross the wire boundary.

Portable import generates a new graph and replica ID outside the archive, then
prepares a validated shallow clone. Local import installs it directly. Remote
import first obtains server acceptance for the exact checkpoint, then installs
metadata, checkpoint, history epoch, and server-Base marker in one IndexedDB
transaction. Both paths require the target graph to be absent, so installation
is complete or absent.

Acknowledgement removes the outbox record matching that content ID. A referenced Tail row stays
pinned until acknowledgement and is deleted only when the fallback Base no
longer needs it.
Storage capability `usage_bytes` reports logical bytes owned by this graph—Base,
Tail, and quarantine—not origin-wide Wasm, font, or HTTP
cache allocation. Browser quota remains the origin quota reported by
StorageManager. A Web Lock allows only one writable tab per
repository-qualified graph; another tab opens read-only.

## SQLite Adapter

The headless native adapter uses one WAL-mode profile database. Schema version 1
contains graph metadata, update, checkpoint, and quarantine tables with the same
stable replica identity, byte accounting, transaction, and checksum behavior as
IndexedDB. Its purpose is native parity,
restart, compaction, corruption, and injected-failure testing until a Tauri shell
is implemented.

## Current Scope and Evolution

CorePort graph locators carry `repository_id` and `graph_id`; the repository ID
partitions browser storage but never enters the canonical Loro document. The
browser directory resolves remote connection metadata. Transport credentials,
Base provenance, and presence are not canonical graph state. The RDF index is
rebuilt on open and has no persisted cache.

Schema changes define readable input versions and the writer gate in the shared
schema contract. The schema-8 transition retains legacy storage homes rather
than copying trees. Explicit conversion initializes the optional capabilities
needed by the new kind in one transaction. Readers never repair missing structure
or automatically combine documents that happen to share a name.

## Verification

- native and browser persistence suites exercise the shared current CorePort corpus;
- restart tests compare semantic graph state after checkpoint plus tail replay;
- fault tests cover before-commit, after-commit, busy/quota, and corrupt records;
- convergence tests exchange binary updates in different and duplicate orders;
- browser outbox tests cover normalized queueing, rejected replacement, checkpoint plus
  Tail resync, restart, protocol encoding, and acknowledgement;
- compaction tests cross the periodic threshold and reopen from the retained
  current/prior checkpoints and remaining Tail;
- graph documents and sync sessions reject non-current schemas; archives accept
  only explicitly supported source schemas and validate the converted copy;
- generated contracts are synchronized before tests and checked by production builds.
