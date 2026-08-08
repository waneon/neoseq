# Core and Domain Architecture

## Scope

The Rust core is the only authority for graph behavior. It accepts intent as
commands and exposes snapshots/events suitable for presentation. It is compiled
as a native library for Tauri and as WebAssembly for browsers.

## Layers

```text
UI / platform bindings
        |
application services: GraphRuntime, JournalService, QueryService
        |
domain: entities, values, commands, invariants
        |
ports: GraphRepository, SyncTransport, Clock, EventSink
        |
Loro and platform adapters
```

The domain layer is pure Rust and does not import Loro, Tokio, Tauri,
`wasm-bindgen`, SQL, or browser types. `graph-core` translates domain commands
into Loro operations and Loro changes back into domain DTOs.

## Domain Vocabulary

- `GraphId`, `PageId`, and `BlockId` are opaque stable IDs.
- `LocalDate` is an ISO calendar date without a timezone. The caller resolves
  “today” using the user's configured IANA timezone before invoking the journal
  command.
- `PropertyKey` is a non-empty normalized Unicode string with a configured
  length limit. Keys are case-sensitive in schema v3.
- `PropertyEntry` pairs a key and typed value. A property bag supports both
  single-valued and repeated keys; every entry has a stable internal slot.
- `PropertyValue` is exactly one of finite number, string, page reference,
  checkbox/boolean, or local date. It never relies on heuristic string parsing.
- `TagId` identifies a graph-scoped tag independently of pages. Page roots and
  blocks carry `TagId` sets outside their property bags.

Dangling page references are valid so offline merge and soft deletion do not
cause data loss. Presentation resolves them to a deleted/missing-page
placeholder.

The property registry is a separately versioned domain contract; registry v5 is
the checked-in current fixture. Each built-in key maps to `shape` and
`placements`. Shape composes cardinality with one of the five value types and,
for strings, any/suggested/closed choices. Placements map page, block, tag
metadata, and tag default targets directly to `user` or `core` access. Their
absence means the property is invalid there; therefore no separate valid-target,
write-policy, or defaultability fields exist.
Unknown user keys accept any of those types on pages and blocks and retain the
command-selected single or repeated cardinality. `page.*` unknown keys are
page-only, the `system.*` namespace is core-managed, and structural keys remain
invalid. ID and date deserialization passes through the same validation as
direct construction.

## Command Model

Commands describe user intent rather than storage mutations. Representative
commands are:

- ensure, rename a regular page, and soft-delete a page;
- ensure a journal page for a local date;
- insert, split, and edit a block, and indent, outdent, move, or delete one or
  more block subtrees;
- set/remove typed properties, including repeated entries;
- apply query/task convenience commands through properties and tag/page/journal
  commands through their explicit structural entities;
- undo/redo the local actor's latest command group.

Generic property commands can mutate only registry-declared user-writable
targets. Page kind, journal identity, lifecycle timestamps, and tombstones are
core-managed and can change only through their owning page, journal, tag, and
touch command paths. Presentation filtering is not an authority boundary.

Each command carries a client-generated idempotency key and expected graph
handle. The runtime rejects malformed IDs, invalid values, cycles, references to
a different graph, and resource-limit violations before mutation. It does not
reject valid commands merely because the network is unavailable.

A command is one user intent and one local history item. Structural commands
accept a non-empty list of block IDs for both single-block and multi-block
actions. Before mutation, the core removes duplicates and descendants already
carried by a selected ancestor, orders the remaining roots from authoritative
outline state, and simulates the whole move, indent, or outdent plan. A rejected
plan leaves no document change or undo item. The UI supplies targets and a move
destination, but never operation order or undo-group controls.

`split_block` is the Enter gesture's atomic boundary. A leading split creates
an empty sibling before the target and leaves the target `BlockId`, content,
properties, tags, and subtree unchanged. A middle split keeps identity and
metadata on the head and creates a new block for the tail without copying source
metadata. A trailing split creates an empty block after the target or as its first
child. The Core resolves semantic placement against authoritative tree state; all
text and tree operations belong to the command's single undo item.

Live regular page names and live tag names are unique in separate graph-scoped
namespaces. Comparison trims and collapses whitespace and applies Unicode
lowercasing; commands preserve the submitted display form. Snapshot open and
ensure, rename, and restore validate the relevant namespace. A remote update is first applied to a
deep document fork and rejected without mutating canonical state if it would
introduce a name collision. A future sync transport must surface that semantic
conflict for user resolution rather than retrying it as a transient failure.

Idempotency is scoped to an open runtime: a bounded result cache prevents
duplicate submission after a bridge timeout. After restart, the client
rehydrates canonical state instead of replaying an uncertain UI request.

## Node and Property Semantics

Page/block content and tag membership are explicit node fields. Extensible
features use well-known properties rather than new persisted fields:

- `tag_refs: Set<TagId>` provides graph-scoped tagging outside properties;
- `query.source: String` and `query.language: String` define an executable
  query;
- `task.status: String` represents states such as `todo`, `doing`, and `done`;
- `task.scheduled: Date`, `task.deadline: Date`, and `task.priority: String`
  drive task views and controls;
- Node `content`, `page.kind: String`, and `journal.date: Date` define page and
  journal presentation; `content` is block Markdown for non-root nodes.
- `system.updated-at: String` records the command timestamp for each directly
  changed page or block. Any block mutation also touches its owning page;
  descendant changes do not touch ancestor blocks.

The versioned property-definition registry is the semantic authority for value
shape and placement access. `task.status` and `task.priority` use suggested open
choices; `page.kind` and `query.language` use closed choices without key-specific
validation branches. Unknown keys remain valid with any supported
`PropertyValue`. The registry does not create a second state model: task and
query services read and write ordinary entries. Client presentation derives its
generic and hidden cases from placements, with sparse feature and metadata
renderer overrides. New identity or relationship semantics still require an
explicit architecture decision.

Entity IDs, tag membership, Loro tree parent/order, schema version, and
tombstones are the explicit structural fields outside property bags.

### Tag Defaults

`AddTag(node, tag)` is a single transaction:

1. add `tag.id` to the node's `tag_refs` CRDT set;
2. read the tag record's default property bag;
3. copy each default only when that property key is absent on the node.

Only properties with a user-accessible `tag_default` placement may enter a
default bag. Task properties declare that placement; unknown user-defined keys
receive the same fallback. `page.*`, `journal.date`, structural keys, and
`system.*` do not. A default bag has at most one value per key in schema v3.

This is materialization, not inheritance. Removing a tag does not remove copied
properties, values already visible to the tagging command are never overwritten,
and later changes to tag defaults affect only subsequent tag operations. A
truly concurrent write to the same property follows Loro's normal per-key
conflict rule. This avoids hidden retroactive changes and makes the result
representable as ordinary CRDT operations.

## Graph Runtime

`GraphRuntime` is an actor with exclusive mutation access to one open Loro
document. All adapters enqueue messages to it. This avoids holding locks across
async calls and gives local commands, persistence, remote imports, and index
updates one ordered integration point.

Its lifecycle is:

1. load the latest valid checkpoint and update tail;
2. validate/migrate the document schema;
3. restore a fingerprint-matching RDF index or rebuild it from the validated
   Loro snapshot, then emit the initial view;
4. accept local commands and remote imports;
5. periodically checkpoint and compact local update storage;
6. flush pending persistence work on suspension/close.

A successfully planned command is applied as one Loro transaction. The runtime
groups all of its operations into one local undo item, exports one binary update,
and emits one semantic event. Undo only tracks local command groups; imported
remote changes are never undone by another user's local undo action. Loro does
not provide transactional rollback, so every user-rejectable structural
condition is checked by the read-only plan before the first CRDT mutation.

The implementation expresses the actor boundary as the single-owner
`GraphRuntime<R, C>` message loop. Its mutable receiver serializes execute,
remote import, snapshot read, and subscription work on native and Wasm without
exposing a lock or Loro container. The generic repository and clock ports have
deterministic in-memory adapters; durable runtimes use the platform persistence
boundary.

Durable runtimes add a pending-write state. A command mutates the owned CRDT, but its
semantic and `SavedLocally` events are withheld until append commits. On failure
the exact bytes and event metadata remain in memory; another mutation and clean
close are rejected until retry succeeds. After-commit retries are idempotent at
the repository checksum boundary.

## Read and Event Model

Callers receive immutable DTOs:

- tag registries, page summaries, and page/block trees for viewport hydration;
- block detail and typed property values;
- SPARQL `SELECT` rows or `ASK` booleans with RDF terms, typed entity references,
  and the projected Loro frontier;
- save, sync, migration, and recoverable error status.

Events identify semantic impact (`BlockTextChanged`, `SubtreeMoved`,
`TagDefaultsChanged`) rather than leaking raw Loro diffs. Every subscription
has a monotonic runtime cursor. If a slow consumer falls behind the bounded
event buffer, it receives `ResyncRequired` and requests a fresh snapshot.

Public core values are domain DTOs, typed errors, semantic events, and opaque
update/snapshot bytes. Raw maps, trees, text handlers, tree IDs, and other Loro
types remain private to `graph-core`.

## Failure Semantics

- Validation failure leaves the document unchanged.
- The durable runtime enters `dirty-unsaved` after an append failure, retains
  and retries the exact exported bytes, and blocks graph close until durability
  succeeds or a future explicit discard workflow is selected.
- Invalid remote bytes are quarantined and reported; the last valid local state
  remains usable.
- A future unsupported schema opens read-only to permit export, never silent
  downgrade.
- Panics do not cross FFI/Wasm boundaries; errors expose stable typed codes and a
  safe diagnostic fallback. The UI owns localized presentation; new errors that
  need user-visible values add structured context through the versioned contract.

## Concurrency and Performance

- One graph actor serializes writes; independent graphs run concurrently.
- Text input is coalesced into short command groups while preserving IME
  composition boundaries.
- Tree/page hydration is paged or viewport-based; the complete graph is not
  copied through the JS boundary after each edit.
- RDF index updates consume changed entity IDs/fields from Loro events, replace
  their emitted triples atomically, and use full snapshots only for rebuild.
- Expensive load, checkpoint, and query work runs away from the UI thread; the
  web runtime lives in a Web Worker.

## Test Contract

- Domain tests cover command invariants, well-known property definitions, and
  tag-default edge cases.
- Model-based tests compare command sequences against an in-memory reference
  model.
- Structural-command tests cover root normalization, all-or-nothing preflight,
  ordering, and one-step undo/redo for plural move, indent, outdent, and delete.
- CRDT convergence tests apply the same randomized operations in different
  orders across peers, including moves, deletes, and journal creation.
- Golden boundary tests ensure native and Wasm adapters serialize identical
  DTOs.
- Crash tests truncate/corrupt update tails and verify recovery from the last
  valid checkpoint.
