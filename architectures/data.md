# CRDT Data and Local Persistence Architecture

## Graph Document Boundary

Each graph maps to exactly one Loro document. This makes graph export, access
control, synchronization, and deletion independent. A peer/session ID is
generated for every simultaneously active graph runtime and is never shared
between tabs, processes, or devices.

The document has two stable root containers:

```text
meta: Map
  graph_id: string
  schema_version: integer
  applied_migrations: Map<migration_id, true>
pages: Map<PageId, PageMap>
```

Root names and container types are permanent protocol. New root fields may be
added, but an existing name cannot change type.

## Pages

`pages` is keyed by stable `PageId`. A page map contains:

```text
properties: PropertyBag
defaults: PropertyBag
outline: MovableTree<BlockData>
```

Regular pages have `page.kind: "regular"` and an atomic `page.title: String`
property; title uniqueness is not required. Journals have `page.kind: "journal"`
and `journal.date: Date`; their display title is derived from the date. Journal
IDs are deterministically derived from `GraphId` and the date, so all replicas
address the same page when creating that day's journal.

Page creation/deletion metadata that affects presentation also uses well-known
string properties such as `system.created-at` and `system.deleted-at` with
canonical timestamp encodings. Concurrent initialization of the two property
bags uses Loro's mergeable/get-or-create operation rather than replacing a child
container under the same map key.

Timestamps are user-facing metadata, not conflict-order authorities. CRDT
ordering determines merge results.

## Blocks and Ordering

Every page owns one nested `outline` movable tree. Every tree node is a block
and its Loro tree ID is wrapped as the stable external `BlockId`. Node data
contains:

```text
markdown: Text
properties: PropertyBag
```

`markdown` is the only user semantic stored outside the property bag. Page
membership is structural and immutable: the containing `PageMap.outline` owns
the block. Indent, outdent, reorder, and subtree moves operate only inside that
tree. Moving content to another page is an explicit copy with new block IDs,
not a cross-tree move.

The runtime enforces and repairs these projection invariants:

- every visible block is reachable from exactly one live page outline;
- no visible cycle exists;
- repeated `tag` entries have page values, though deleted/missing targets remain
  as dangling refs;
- invalid property encodings are quarantined instead of coerced.

Loro provides conflict-free hierarchy moves and sibling ordering. A block
command carries its owning `PageId` as a locality hint, and the core rejects a
page/block mismatch without searching other page trees.

## Uniform Property Bag and Encoding

Every page and block has the same logical `PropertyBag`:

```text
PropertyBag = Map<PropertySlot, PropertyEntry>
PropertyEntry = { key: PropertyKey, value: EncodedPropertyValue }
```

`PropertySlot` is internal identity. A single-valued key uses one deterministic
slot. A repeated key uses a deterministic logical member identity; for example,
each `tag: PageId` entry uses the referenced page ID, making tag addition
idempotent while allowing multiple tags. The public model remains a collection
of string key/typed value pairs and does not expose slot encoding.

Each entry value is one canonical JSON UTF-8 string in the Loro map, so a
concurrent write cannot combine a type from one write with a payload from
another. Its decoded form is:

```text
{ type: "number",   value: finite f64 }
{ type: "string",   value: UTF-8 string }
{ type: "page",     value: PageId }
{ type: "checkbox", value: boolean }
{ type: "date",     value: YYYY-MM-DD }
```

The JSON representation is canonical and versioned with document schema 2. It
is decoded into `PropertyEntry` and `PropertyValue` immediately; raw JSON does
not escape the projection. A single slot is `s:<key>`. A repeated slot is
`r:<key>:<sha256(canonical-value)>`, which makes equal member addition
idempotent. Map semantics merge slots independently, and concurrent writes to
one slot resolve as one complete value.

Well-known entries include `tag`, `query.source`, `query.language`, task fields,
`page.title`, `page.kind`, and `journal.date`. They use exactly
the same encoding and synchronization path as user-defined properties. The
registry adds type/cardinality validation and feature projection but no extra
storage.

## Deletion and Repair

Deletion is initially logical:

- block deletion uses the tree CRDT's deletion semantics;
- page deletion writes `system.deleted-at` and hides its nested outline;
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
index-cache, and quarantine tables. Update append atomically inserts the update
and outbox row and advances `next_sequence`. Checkpoint insertion precedes the
compaction marker; neither operation deletes recovery evidence. Busy, locked,
full, and corrupt SQLite results map to stable storage errors.

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

The current core opens document schema 2 only. Schema 1 used one graph-global
outline and encoded page membership as a block property; moving those nodes
into nested page trees cannot preserve their Loro tree IDs. The core therefore
rejects schema 1 explicitly instead of silently rewriting block identity. Its
fixtures remain as historical compatibility inputs, while schema-2 fixtures are
loaded by native and Wasm tests. Future identity-preserving migrations are
monotonic, idempotent functions recorded in `applied_migrations`. A remote graph
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
