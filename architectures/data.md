# CRDT Data and Local Persistence Architecture

## Graph Document Boundary

Each graph maps to exactly one Loro document. This makes graph export, access
control, synchronization, and deletion independent. A peer/session ID is
generated for every simultaneously active graph runtime and is never shared
between tabs, processes, or devices.

The document has three stable root containers:

```text
meta: Map
  graph_id: string
  schema_version: integer
  applied_migrations: Map<migration_id, true>
pages: Map<PageId, PageMap>
tags: Map<TagId, TagRecord>
```

Root names and container types are permanent protocol. New root fields may be
added, but an existing name cannot change type.

The Loro document and its durable update/checkpoint history are the only
canonical graph representation. RDF triples, term dictionaries, full-text
postings, hierarchy accelerators, query plans, and query results are derived
state outside these roots. The query projector must be able to reproduce their
complete semantic contents from any validated document snapshot; import/export
never treats an index as graph data.

## Pages

`pages` is keyed by stable `PageId`. A page map contains:

```text
root: NodeData
outline: MovableTree<NodeData>
```

The root node's collaborative `content` is the regular page title. Live regular
page names are unique within a graph after trimming, collapsing whitespace, and
Unicode lowercasing. The stable `PageId`, not the normalized name, remains
identity. Deletion releases a name; restore is rejected if another live page
has claimed it. Regular pages have `builtin.page-kind: "regular"` in the root property
bag. Journals have `builtin.page-kind: "journal"`
and `builtin.journal-date: Date`; their display title is derived from the date. Journal
IDs are deterministically derived from `GraphId` and the date, so all replicas
address the same page when creating that day's journal.

Page lifecycle metadata in the root node uses well-known string properties
`builtin.created-at`, `builtin.updated-at`, and `builtin.deleted-at` with canonical
timestamp encodings. Block nodes also carry `builtin.updated-at`. A block
mutation updates both that block and its owning page, while changes below a
block do not implicitly rewrite ancestor block timestamps. Concurrent
initialization uses Loro's
mergeable/get-or-create operation rather than replacing a child container under
the same map key.

Timestamps are user-facing metadata, not conflict-order authorities. CRDT
ordering determines merge results.

## Nodes and Ordering

Page roots and outline blocks share exactly one persisted payload:

```text
NodeData
  content: Text
  properties: PropertyBag
  tag_refs: Map<TagId, true>
```

Every page owns one nested `outline` movable tree. Every tree node is a block
and its Loro tree ID is wrapped as the stable external `BlockId`. Node data
uses `content` as block Markdown; the page root uses the same field as its
title. Page membership is structural and immutable: the containing
`PageMap.outline` owns
the block. Indent, outdent, reorder, and subtree moves operate only inside that
tree. Moving content to another page is an explicit copy with new block IDs,
not a cross-tree move.

Enter preserves node identity at document boundaries. At the start of a block,
it inserts an empty sibling before the existing node rather than moving content
into a new node, so the original `BlockId`, properties, tags, and descendants
move down together. A middle split retains that identity and metadata on the
head; only the Markdown tail receives a new `BlockId`, without copied source
metadata.

The runtime enforces and repairs these projection invariants:

- every visible block is reachable from exactly one live page outline;
- no visible cycle exists;
- tag references contain valid `TagId`s, though deleted/missing targets remain
  as dangling refs;
- invalid property encodings are quarantined instead of coerced.

Loro provides conflict-free hierarchy moves and sibling ordering. A block
command carries its owning `PageId` as a locality hint, and the core rejects a
page/block mismatch without searching other page trees.

## Tags

`tags` is keyed by stable `TagId`. A tag record contains an atomic `name`, a
property bag for lifecycle metadata, and a default property bag. Node
membership is a CRDT set encoded as `tag_refs: Map<TagId, true>`; it is not a
property and never points to a page. Renaming a tag therefore does not rewrite
members. Reverse membership is a derived local query index, not a second
authoritative CRDT relation.

Live tag names use the same normalization and uniqueness rule as page names,
in an independent namespace. Deleted tag names are reusable, and a restore
that would collide is rejected. The original spelling and spacing remain the
stored display name; normalization is lookup identity only.

Adding a tag and materializing its missing defaults is one transaction.
Removing it leaves materialized properties intact. Deleting a tag is logical;
node references remain as inspectable dangling references until explicit
cleanup.

Tag defaults are copied when a tag is attached. They are materialized ordinary
properties, not inherited or retroactive values.

## Uniform Property Bag and Encoding

Every page and block has the same logical `PropertyBag`:

```text
PropertyBag = Map<PropertySlot, PropertyEntry>
PropertyEntry = { key: PropertyKey, value: EncodedPropertyValue }
```

`PropertySlot` is internal identity. A single-valued key uses one deterministic
slot. A repeated key uses a deterministic logical member identity. The public
model remains a collection of string key/typed value pairs and does not expose
slot encoding.

Each entry value is one canonical JSON UTF-8 string in the Loro map, so a
concurrent write cannot combine a type from one write with a payload from
another. Its decoded form is:

```text
{ type: "number",   value: finite f64 }
{ type: "string",   value: UTF-8 string }
{ type: "page",     value: PageId }
{ type: "checkbox", value: boolean }
{ type: "date",     value: YYYY-MM-DD }
{ type: "query",    value: { language: stable-id, source: UTF-8 string } }
```

The JSON representation is canonical and versioned with document schema 4. It
is decoded into `PropertyEntry` and `PropertyValue` immediately; raw JSON does
not escape the projection. A single slot is `s:<key>`. A repeated slot is
`r:<key>:<sha256(canonical-value)>`, which makes equal member addition
idempotent. Map semantics merge slots independently, and concurrent writes to
one slot resolve as one complete value.

Official entries use registered two-level `builtin.*` keys; user-defined entries
use two-level `custom.*` keys. `builtin.query` is one single-valued composite, so
language and source cannot merge or undo independently. Registry metadata adds
type, cardinality, write, visibility, and target validation without a second
storage path.

## Deletion and Repair

Deletion is initially logical:

- block deletion uses the tree CRDT's deletion semantics;
- page deletion writes `builtin.deleted-at` and hides its nested outline;
- tag deletion writes `builtin.deleted-at` without rewriting node references;
- references to deleted entities remain inspectable;
- restoring a page removes that property and reveals its surviving outline.

Validation after import is deterministic. Unsafe remote encodings, invalid
property targets/defaults, and malformed page outline containers are omitted
from the domain projection and reported in a sorted quarantine list; supported
dangling tag references remain lossless. Local commands prevent these states
before mutation. Future physical repair uses normal CRDT operations and is
separate from checkpoint/retention trimming.

## Local Repository Port

The core depends on this logical repository contract:

```text
create/open graph metadata
load latest checkpoint
stream update records after checkpoint
append update atomically
save checkpoint atomically
compact an update prefix after a durable checkpoint
delete local replica explicitly
```

Update records include a local sequence, checksum, Loro bytes, creation time,
and optional remote acknowledgement metadata. The Loro version vector/frontiers
remain the synchronization truth; repository sequences only address local
records.

`LocalGraphRepository` fixes these DTOs and operations in
`graph-core`. SHA-256 covers the exact stored bytes. Append returns the assigned
local sequence and checksum; identical bytes are idempotent so an adapter can
report an after-commit failure and safely retry. Graph locators distinguish
local and remote metadata, while the current local Web boundary rejects remote opens.

### Native Storage

macOS and Android use SQLite in WAL mode. Metadata, update blobs, checkpoints,
and outbox acknowledgements are tables in one database per application profile.
Large graph blobs may move to content-addressed files later without changing the
port. OS-provided app storage and backup policies are used; no graph is placed
in a user-visible directory without an explicit export.

SQLite migration version 1 creates metadata, update, checkpoint, outbox-ready,
index-cache, and quarantine tables. The index-cache table is an optional
performance cache keyed by the full Loro-frontier/projection/query-profile/text-
analyzer fingerprint; no recovery path depends on it. Update append atomically
inserts the update and outbox row and advances `next_sequence`. Checkpoint
insertion precedes the compaction marker; neither operation deletes recovery
evidence. Busy, locked, full, and corrupt SQLite results map to stable storage
errors.

### Browser Storage

The web client uses IndexedDB with the same logical records. Transactions
atomically append an update and advance local metadata. Storage
quota/persistence status is surfaced to the UI. A Service Worker caches
application assets, but never acts as the graph's sole persistence layer.

IndexedDB version 2 stores metadata, updates, checkpoints, and quarantine
records. Upgrade removes the obsolete feasibility outbox and derived-index cache
stores. A unique `(graph_id, checksum)` index makes update retry idempotence an
indexed lookup instead of an O(n) payload scan. Clean close writes a checkpoint,
deletes the included update prefix and older checkpoints, and advances the
compaction marker in one transaction. The Worker owns
both Wasm core and repository, so update/checkpoint buffers normally never
cross the main-thread boundary. Binary diagnostic exports use transferable
`ArrayBuffer`s. Browser persistence and quota estimates populate the storage
capability DTO.

The current browser runtime rebuilds the RDF index in Worker memory after open;
native adapters may restore the optional SQLite cache. This platform difference
changes startup cost only, never SPARQL results or consistency.

## Checkpointing and Recovery

- Append-only updates are the immediate durability path.
- A checkpoint contains an exported Loro snapshot, its version information,
  schema version, checksum, and last included local sequence.
- Checkpoint creation writes a new record before marking older updates
  compactable.
- Startup chooses the newest valid checkpoint and replays checksum-valid
  updates.
- A corrupt tail is quarantined and exportable for support; valid history is not
  overwritten.
- Compaction is triggered by update bytes/count and idle time, never on every
  edit.

`CheckpointTracker` implements count, byte, and idle thresholds; adapters also
checkpoint on a clean close. Startup validates repository schema metadata,
tries checkpoints newest-first, and replays the contiguous checksum-valid tail.
After a corrupt tail member, it and all later records remain quarantined under
stable export handles. Stored graphs never silently reopen as an empty graph
when no valid checkpoint exists.

## Schema Evolution

The current core writes document schema 4. Schema 1 used one graph-global
outline, while schema 2 used page-backed tags and lacked root `NodeData`.
Converting a page that may simultaneously be note content and a tag definition
requires an explicit user-facing identity policy, so schemas 1 and 2 are
rejected rather than silently splitting or merging identities. Schema 3 is the
supported upgrade input: startup deterministically renames official keys, moves
legacy user keys under `custom.*`, and combines query source and language. A
source-only query receives the historical default language; a language-only
query becomes an empty-source, non-executing draft. Startup stores a v4
checkpoint before advancing repository metadata. The monotonic migration is
recorded in `applied_migrations`, and old keys are removed only after their
replacement is stored. A remote graph
migration also requires a server-advertised minimum client version so an older
client cannot write an incompatible shape.

## Export and Import

A portable graph archive contains a manifest, one verified Loro snapshot/update
bundle, and optional attachments in a versioned container. Import always creates
or explicitly replaces a target graph; it never merges merely because titles
match. Archive parsing applies decompression, path, size, and checksum limits
before content reaches Loro.

## Upstream Basis

The model relies on Loro's documented
[movable tree](https://loro.dev/docs/tutorial/tree),
[typed containers](https://loro.dev/docs/concepts/container), and
[version-vector update exchange](https://www.loro.dev/docs/tutorial/sync).
