# Neoseq Architecture

## Purpose

Neoseq is a local-first, outliner-based note-taking application. A graph
contains pages; a page contains ordered root blocks; and every block may contain
ordered child blocks. Daily journal pages are the primary capture surface. Each
block has collaborative Markdown text. Tags are graph-scoped entities; queries,
task fields, and extensible metadata use typed properties. Users can query
blocks and pages through a safe, read-only SPARQL profile.

This document is the architectural source of truth. Component-level detail lives
under [`architectures/`](architectures/).

The implemented Step 5 boundary is the local Web client, shared domain/core,
reproducible RDF index and SPARQL query engine, Wasm adapter, IndexedDB
repository, and a headless SQLite parity adapter. Native application shells,
remote synchronization, and release provenance shown below are target
architecture for later steps and are not current build artifacts.

## Architectural Drivers

- The product must work offline and support local-only graphs.
- Remote graphs must converge through Loro CRDT updates and synchronize in real
  time when connected.
- One Rust core must own domain rules, graph mutation, indexing, and query
  semantics on web, macOS, and Android.
- The UI should be shared across platforms without making the domain depend on a
  webview or JavaScript runtime.
- Product localization and user preference must remain presentation concerns:
  changing UI language, how a date is written, or what a key is bound to cannot
  mutate graph data or alter domain, query, and synchronization semantics.
- Development and builds must be reproducible through Nix, subject to Apple
  signing and SDK constraints.
- Nix dependency caches must be invalidated by dependency-manifest content, not
  by machine-local store history or host-platform assumptions.
- User-authored queries must be expressive without gaining filesystem, network,
  or process capabilities.
- Graph-wide query, search, and projection reads must use a reproducible RDF
  index rather than traverse the canonical Loro document; deleting the index
  must never delete user data.
- Extensible metadata must use one property model; identity and relationships
  such as containment and tag membership remain explicit structural data.
- A user must be able to capture bounded, local diagnostic evidence for a human
  or coding agent without enabling telemetry or disclosing note content by default,
  with an explicit one-recording option when content is needed to reproduce a bug.

## System Context

```mermaid
flowchart LR
    UI[React / TypeScript UI]
    Port[Typed CorePort]
    Native[Tauri 2 adapter<br/>macOS + Android]
    Web[WebAssembly adapter<br/>browser]
    Core[Rust graph core]
    Local[(Local replica<br/>SQLite or IndexedDB)]
    Index[(Derived RDF index<br/>SPARQL + search)]
    Sync[Sync agent]
    Server[Remote sync server<br/>Rust]
    DB[(PostgreSQL)]

    UI --> Port
    Port --> Native --> Core
    Port --> Web --> Core
    Core --> Local
    Core --> Index
    Core --> Sync
    Sync <-->|TLS WebSocket| Server
    Server --> DB
```

The UI calls the same versioned `CorePort` contract on every platform. Native
clients invoke the Rust core in-process through Tauri commands. The browser
loads the same core compiled to WebAssembly. A local graph stops at durable
local storage. A remote graph uses the identical local replica plus a sync
agent.

## Components

- `domain` owns IDs, uniform property types/definitions, commands, invariants,
  journal rules, and tag-default rules. It does not know Loro, storage,
  transport, or UI.
- `graph-core` owns the graph runtime, Loro projection, transactions, undo, and
  events. It does not know platform APIs or authentication.
- `query` owns the Loro-to-RDF projection, triple/text indexes, SPARQL parsing
  and planning, and budgeted execution. It cannot mutate CRDT state, scan Loro
  as a normal query path, select another graph, or call the server.
- `platform` owns native/WebAssembly bindings plus persistence and transport
  adapters. It contains no domain decisions.
- `diagnostics` is a local, opt-in observation plane across UI, adapter, core,
  query, and persistence boundaries. Its standard policy records typed state
  relationships without values and correlates semantic UI intent, boundary spans,
  reconciliation and terminal presentation checkpoints. Its enhanced policy separately
  classifies explicitly consented content. Neither alters graph state nor uses `CorePort`
  as a logging API, and disabled recording avoids feature-state projection work.
- `app-ui` owns editing interaction, block selection, navigation, the command
  layer, failure reporting, browser-local preferences, localization, and
  responsive presentation. It does not hold canonical graph state, and the
  preferences it owns — appearance, UI language, journal timezone and date
  format, keyboard bindings — are presentation only: none of them can change
  domain, query or synchronization semantics. Its visual contract — tokens,
  disclosure rules, motion constraints, and the committed contrast table — is
  [`DESIGN.md`](DESIGN.md).
- The future `sync-server` owns authentication boundaries, graph authorization, durable
  update relay, and compaction. It does not interpret notes or execute queries.

Detailed contracts are in:

- [Core and domain](architectures/core.md)
- [CRDT data model and persistence](architectures/data.md)
- [Query engine](architectures/query.md)
- [Client applications](architectures/clients.md)
- [Property command picker](architectures/property-command-picker.md)
- [Internationalization](architectures/i18n.md)
- [Diagnostic recording and bug artifacts](architectures/diagnostics.md)
- [Design language and UI contract](DESIGN.md)
- [Remote synchronization server](architectures/server.md)
- [Build, delivery, and verification](architectures/build.md)

## Core Runtime Contract

One `GraphRuntime` owns each open graph. It serializes commands so a user action
is one Loro transaction, persists the resulting update, atomically publishes a
derived RDF index revision, and then emits a typed event. Remote imports enter
through the same runtime and update the same projection. Reads use immutable
DTOs; callers never receive Loro containers.

The command boundary is also the local history boundary: one user intent is one
domain command, one undo item, one persisted CRDT update, and one semantic event.
Multi-block edits, parsed outline insertion, and Enter-driven block splitting
therefore cross the boundary as one command; the UI never holds an undo group
open across asynchronous calls.

The boundary is asynchronous and versioned:

```text
open_graph(locator) -> graph_handle + graph_summary
execute(graph_handle, command) -> command_result
read(graph_handle) -> graph_summary
read_page(graph_handle, page_id) -> page_view
query(graph_handle, sparql_request) -> select_result | ask_result
subscribe(graph_handle, cursor) -> graph_events
close_graph(graph_handle)
```

Large text edits and synchronization payloads use binary buffers rather than
JSON. All other boundary values are generated from a shared schema to keep
TypeScript, native, and WebAssembly adapters compatible.

## Data and Consistency Model

- A graph is one Loro document and one independent synchronization/security
  unit.
- Pages are stored by stable `PageId`; each page owns one ordered, movable Loro
  tree containing only that page's blocks.
- Page roots and blocks share one node payload: collaborative content, a
  property bag, and a set of `TagId` references. A page remains the aggregate
  and read boundary around its root node and page-local outline.
- Tags are first-class graph entities in a `TagId`-keyed registry. Query and
  task features remain projections over well-known property keys.
- Live regular page names and live tag names are unique in separate graph-scoped
  namespaces after case and whitespace normalization; stable IDs remain entity
  identity. Snapshot open, local commands, and staged remote imports enforce
  the invariant before canonical state is published.
- Block ownership is structural: a block belongs to the page whose nested tree
  contains it. Moves are page-local, and block commands carry both `PageId` and
  `BlockId` so reads and writes never scan other pages.
- Property entries merge independently. Keys have exactly two namespaces:
  registered Neoseq-owned `builtin.*` keys and user-owned `custom.*` keys.
  Each value is an atomic tagged number, string, page reference, checkbox,
  local date, or the closed `QuerySpec { language, source }` composite.
- `builtin.updated-at` is written on every direct page/block mutation. A block
  mutation also updates its owning page so page recency includes outline work.
- Journal identity is deterministic from `(GraphId, local date)`, making journal
  creation idempotent across offline devices.
- Adding a tag reference copies that tag's defaults into missing node properties
  in the same transaction. Existing values win; later default changes are not
  retroactive.
- Deleted pages are soft-deleted in shared state. References remain resolvable
  as tombstones until explicit, policy-driven cleanup.
- The per-graph RDF triple index, text/hierarchy accelerators, compiled SPARQL
  plans, UI selection, connection status, and presence are derived or ephemeral
  and never become canonical CRDT state. Each index revision identifies the
  exact Loro frontier from which it was projected and is discarded/rebuilt when
  its fingerprint is stale.

CRDT/document mechanics such as entity IDs, schema version, tree parent/order,
and tombstones are not user-visible semantics and remain structural metadata.
Tag identity/membership and node containment are also explicit structural data.

## Local-First Write and Sync Flow

1. The UI submits a domain command with an idempotency key.
2. `GraphRuntime` validates it and applies one Loro transaction.
3. The local repository durably appends the exported update before the runtime
   reports a saved state.
4. The RDF/text index publishes one complete revision and subscribers receive a
   semantic graph event.
5. For a remote graph, the sync agent sends the same update until acknowledged.
6. The server authorizes and durably stores the update before broadcasting it.
7. Peers import updates in any order; Loro convergence, not server sequence,
   defines graph state.

The editor may render optimistically, but it must display an unsaved state until
step 3 succeeds. Network failure never blocks local editing.

## Deployment Units

- **Web client (current):** static assets, Web Worker-hosted Rust/Wasm core,
  IndexedDB repository, and Web Locks-enforced single-tab editing per graph.
- **macOS client (planned):** Tauri application, in-process Rust core, SQLite repository,
  and native WebSocket transport.
- **Android client (planned):** Tauri application with the same frontend and Rust core,
  SQLite repository, and platform lifecycle integration.
- **Sync service (planned):** stateless HTTP/WebSocket Rust processes backed by
  PostgreSQL; graph rooms are disposable caches reconstructed from checkpoints
  and updates.

## Security and Privacy Boundaries

- Local-only graphs never contact the sync service.
- Diagnostic recording is explicitly started, locally bounded, and never uploaded
  by the application. Standard artifacts exclude content while retaining typed
  state relationships. Enhanced capture is off by default, fixed for one recording,
  limited to a disclosed scope, and separately confirmed before sensitive export.
- Remote endpoints require TLS and authenticated graph membership. Authorization
  metadata is server state, not CRDT state, so clients cannot grant themselves
  access by editing a graph.
- The server applies frame-size, update-rate, and document-size limits before
  accepting untrusted CRDT bytes.
- User queries run only in the client core against the current graph's derived
  RDF index. The accepted SPARQL profile excludes update, dataset selection,
  federation, and other I/O. V1 bounds source, algebra, bindings, and rows; the
  browser runs evaluation in the graph Worker rather than the UI thread.
- The initial remote design is not end-to-end encrypted: the service
  reconstructs Loro documents for differential sync and compaction. E2EE would
  require a new opaque-log and key-management design and is intentionally
  deferred.

## Repository Shape

```text
crates/
  domain/             # Pure domain model and commands
  graph-core/         # Loro-backed runtime and application services
  query/              # RDF projector/index, SPARQL planner and executor
  platform-native/    # Headless SQLite and native CorePort parity adapter
  platform-web/       # Product wasm-bindgen graph-core adapter
apps/
  client/             # React/TypeScript UI, i18n, Worker, and IndexedDB adapter
architectures/        # Component architecture documents
steps/                # Verifiable, staged implementation plan
flake.nix
flake.lock
Cargo.toml
Cargo.lock
pnpm-lock.yaml
```

Dependencies point inward: platform and delivery crates depend on application
and domain crates, never the reverse. The future sync protocol will contain
transport types only and will not expose server persistence models.

## Evolution Rules

- CRDT schema changes require compatibility fixtures and an updated
  [data architecture](architectures/data.md). They use an idempotent migration
  when entity identity can be preserved; otherwise the old schema is rejected
  explicitly and requires a separate import/conversion boundary.
- `CorePort` and sync-protocol changes are explicitly versioned and tolerate one
  supported rolling-upgrade window.
- New platforms implement existing ports; they do not fork domain behavior.
- New metadata features define well-known properties and projections. New
  identity or relationship semantics require an explicit structural design;
  either kind of schema change requires compatibility fixtures.
- RDF vocabulary/projection, query-profile, and text-analyzer changes are
  versioned independently from the CRDT schema. Cached indexes from any
  mismatched version are rebuilt from Loro rather than migrated as user data.
- Diagnostic artifact schema and capture policy are versioned independently
  from product contracts; new fields, relationship signals, content categories,
  or scope changes require privacy review and compatibility fixtures.
- Architecture-affecting code changes update this document and the relevant
  component document in the same change.
