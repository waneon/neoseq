# Client Application Architecture

## Scope

The current client is a React and TypeScript single-page application bundled by
Vite. It runs the Rust graph core as WebAssembly in a dedicated Worker, uses
IndexedDB for local persistence, and synchronizes remote graphs through a
main-thread `SyncAgent`. React owns presentation state—focus, selection, open
layers, composition buffers, and optimistic rows—while the Rust runtime owns
canonical graph state.

Future Tauri shells reuse this interaction model through the same CorePort.
[`../DESIGN.md`](../DESIGN.md) defines the production UI/UX contract, and
[`i18n.md`](i18n.md) defines presentation-only localization.

## CorePort and Session

The frontend depends on the asynchronous CorePort v1 operations:

```text
open_graph, execute, read, read_page, query, subscribe, close_graph
```

DTOs are generated from
[`../contracts/core-port.json`](../contracts/core-port.json). Components never
call Wasm, IndexedDB, or native APIs directly. Browser-only graph listing,
deletion, copy import/export, pending-write retry, storage capabilities, and test
fault controls are adapter operations outside the portable product contract.

`GraphSession` serializes local commands and remote imports. After either it
drains semantic events, refreshes the graph summary, and rehydrates affected
pages. It owns subscription cursors, turns an ambiguous storage failure into a
retry of the exact pending update, and delegates remote transport state to one
`SyncAgent` per remote graph. Callers see immutable DTOs and cannot hold a Loro
container.

## Browser Adapter

`core-worker.ts` implements CorePort messaging on the main thread;
`graph-worker.ts` owns Wasm and persistence. Transferable `ArrayBuffer`s carry
binary CRDT or archive data without cloning. Wasm initializes only when a graph
opens, so graph listing and deletion do not pay core startup cost.

The production build uses the wall clock and ordinary adapter operations. Vite
test mode adds a storage contract page, deterministic time, and explicit fault
controls. Those controls and the current CorePort corpus are test-only chunks,
not public product routes.

The graph picker exports `.neoseq` copies and imports each selected archive as a
new local graph. The main thread transfers bytes but never decodes graph state;
the Worker delegates the bounded container to Wasm, validates source and cloned
documents through the core, and atomically installs the clone before the browser
directory publishes its suggested display name. See
[`graph-archive.md`](graph-archive.md).

Graph display names, local/remote kind, and remote server origin are
browser-directory metadata in localStorage. Credentials are scoped to the
server origin in sessionStorage and are never stored in graph data, localStorage,
or URLs. Canonical note data remains in the Loro repository. A Web Lock grants
one tab a writable lease per graph; a competing tab is read-only. The Loro peer
ID is generated once and persisted with graph metadata; only the transport
session ID is fresh for each connection.

The headless native CorePort in `platform-native` exercises equivalent runtime,
SQLite, recovery, and DTO behavior. It is not yet a desktop or mobile UI.

## Editor State and Input

Canonical and interaction state have one owner each. Graph content and shared
saved views come only from the reconciled Core snapshot; browser-local durable
preferences come only from their subscribed store. React and headless UI
libraries may hold focus, open layers, drafts, optimistic overlays, and an active
pointer gesture, but must not retain a second stable copy of a durable value.

Persistent controls are controlled adapters: they render the authoritative
value plus an explicitly transient overlay, emit one semantic command at the
interaction boundary, and reconcile the overlay when that command, undo/redo,
or a remote import publishes a new authoritative value. A command rejected
before applying drops its overlay; an applied but non-durable command reconciles
to the in-memory canonical value and remains visibly unsaved. Text and
composition drafts may instead preserve or rebase newer input, but that conflict
policy must be explicit; initialization from a prop or library `initialState`
alone is not reconciliation.

The outline has two mutually exclusive interaction modes: a text caret in one
editor or structural selection of block IDs. Taking one clears the other so text
deletion and subtree deletion cannot be confused. Pure selection arithmetic
lives in `features/outline/selection.ts`; browser tests own geometry-dependent
marquee and drag behavior.

Transient outline layers and pointer gestures are closed state machines in
`features/outline/interaction-state.ts`. Exactly one property, tag, completion,
or block menu overlay may be open, and a pointer is exactly idle, selecting, or
dragging with an optional drop target. Reducer transitions replace independent
nullable flags so impossible combinations cannot be rendered or handed to a row.

Editor drafts, generated-closer provenance, and the pending-row queue form one
immutable reducer state in `features/outline/draft-state.ts`. A pending ID is
adopted, its later queued anchors are remapped, and its raced input moves to the
canonical block in one transition. The outliner reads the same latest snapshot
from async callbacks and React rendering; it has no independent force-render path.

IME composition remains local until a composition boundary. Normal typing uses
a short debounce, submits block ID plus text-range intent, then reconciles with
the authoritative core event while preserving the selection. Structural commands
cross CorePort immediately and may render optimistically only when the inverse
is known.

Paired delimiters are a client input transform around the textarea's native input
boundary. A pure planner handles cancelable opener, selection-wrap, closer-overtype,
and paired-backspace intents at `beforeinput`. Editor-local ephemeral markers track
only generated closers through draft edits. Non-cancelable composition input stays
native while active, then a post-input reconciliation uses those markers to remove
only an IME-inserted duplicate closer. The normalized value rejoins the ordinary
draft and debounce path as one text splice; the core, CRDT document, and Markdown
projection carry no pairing policy or pair-origin metadata.

Inactive blocks with Markdown syntax use the shared CommonMark reading projection;
activating non-interactive rendered content restores the existing source textarea.
Plain text may stay on the textarea fast path because its projection is identical.
The renderer is disposable client state: it never persists an AST or HTML, and it
does not infer properties, tags, tasks, references, or other graph semantics. Raw
HTML is not interpreted, external images never load, and links pass through the
profile's protocol allowlist. Query content cells reuse the same policy through a
compact phrasing-only projection. See
[`markdown-rendering.md`](markdown-rendering.md).

Builder-authored block query results reuse that text intent and the shared
property/tag controls through a query-level edit coordinator. The coordinator
hydrates only the active result's page, owns one draft across Table/List view
changes, and sends ordinary domain commands. A result that stops matching while
active stays pinned until its editor closes; query rows themselves are never
optimistically rewritten. Hand-written SPARQL, summaries, and derived relation
columns remain read-only.

The session exposes separate presentation and canonical revisions. Authoritative
page hydration advances the former so mounted views reconcile, while only a
possible graph mutation or remote import advances the latter and invalidates
visible queries.

Enter is one atomic `split_block` command; on an empty block it is instead an
insert below, so the caret always lands on the new line. A pending row mounts
immediately so fast typing has a focus target, then swaps to the real block ID
during reconciliation. Pending rows may chain; queued structural intents replay in
order after IDs resolve. Rejection applies the known inverse and retains a draft
until authoritative state agrees.

Bulk move, indent, outdent, and delete send one plural command for the selected
roots. The core removes duplicate descendants, derives authoritative order, and
owns the transaction and undo group. A structural copy projects one versioned
outline fragment to lossless Neoseq JSON, readable HTML, and plain Markdown.
`paste_outline` validates and applies a Neoseq fragment atomically; unambiguous
external lists use `insert_outline`, while ordinary multiline text stays in the
editor. See [outline clipboard](clipboard.md).

## Property-Driven Features

[`../contracts/property-registry.json`](../contracts/property-registry.json) is
imported directly by the client and Rust domain. Placement access determines
whether a property is hidden, read-only, or editable; semantic ordering keeps
query sort independent of localized display labels. Sparse renderer maps add
specialized controls without becoming a schema authority:

- `builtin.query` provides the query builder, a SPARQL escape hatch, and
  schema-owned saved result views. One surface serves both grounds it appears on:
  embedded in the outline its views stay in a menu, and on a routed tag page —
  where the query *is* the body — they become a permanent tab strip the reader
  names, arranges, and deletes. It is authored only through `/` on a block or a
  page: the generic property route never offers it, so a query is never
  half-created by a picker. A tag's query needs no authoring step at all; the tag
  page seeds a plan that asks what the tag is for and writes nothing until a
  reader shapes it;
- `builtin.task-*` provides workflow, priority, moment, and recurrence controls. A
  moment is a `date` key plus an optional `HH:MM` companion key
  (`builtin.task-scheduled-time`, `builtin.task-deadline-time`), so the day stays a
  typed date the query index can compare while its time of day refines it. The
  companion keys are feature-only: the date editor writes them, the date chip reads
  them, and the generic property route never offers a key whose value would be
  unanchored. `builtin.task-repeat` is a client-interpreted `<count><unit>` string;
  completing a recurring task is a client behaviour composed of ordinary property
  commands, not a core verb;
- registered lifecycle and page built-ins appear as read-only page information;
- unknown `user.*` keys use the generic typed editor, while unknown
  `builtin.*` keys are rendered generically but remain read-only;
- tag membership remains structural: the block `Tags` picker and the outline's
  inline `#` menu attach existing tags (`add_tag`/`remove_tag`). A tag reference
  under a block is a link to that tag's own route, never a writing surface. The
  routed tags view is the index and the one place a tag is created; a tag's own
  route owns everything about one tag — its name, its `defaults` through the
  shared owner-based property commands, its deletion, and its query.

The shared picker distinguishes a present empty field from an absent property.
It can ensure an empty field, clear only its values, or remove the field, and
renders empty fields as “No value” on every owner surface.

Document renderers receive immutable schema snapshots and issue semantic
commands; they never mutate JSON or Loro containers. Unknown document versions
remain visible as unsupported read-only data. Removing a specialized renderer
never hides or destroys its values.

## Commands, Navigation, and Errors

`features/commands/` owns the command registry, binding table, global keyboard
arbitration, command palette, shortcut sheet, and overflow menu. All routes to a
command share its localized label, binding, icon, and disabled reason. IME and
already-handled events win before global shortcuts; global shortcuts stand down
while a modal is open.

Routes use stable page and tag IDs; a tag is a route (`t/:tagId`) rather than a
card in a grid, so everything the graph names has one address. Settings is a
dialog whose section is represented by a query parameter, so browser Back closes
it without losing editor context.
Journal navigation resolves the user's configured timezone to a `LocalDate` and
asks the core to ensure that deterministic journal.

`features/history/` is the single client coordinator for undo/redo and for
opening anything the graph names by ID — including a tag, which has a place
rather than a line to be scrolled to. It consumes the core's semantic history effect, chooses
a regular-page or journal route, and hands block reveal to the mounted outliner;
following a query result uses the same reveal path. The outliner expands ancestors and
scrolls its virtual list; only an undo/redo invoked from an active block editor
may transfer editor focus. Graph-scoped effects leave the current route intact.
The complete policy is in [`history-navigation.md`](history-navigation.md).

`features/notify/` owns one toast queue. Rejected actions without a persistent
home report there; durability stays in the save slot, field validation stays by
the field, and query errors stay in the query block. Stable CorePort errors map
to localized messages while raw internal detail stays off screen.

## Local, Sync, and Live State

Three independent status slots prevent network state from being mistaken for
local data loss:

- saved: no persistent mark;
- saving: a delayed quiet indicator;
- unsaved: a persistent error reason and retry action;
- sync: pending, synced, paused for auth/revocation/incompatibility, or error;
- live: connecting, live, offline, or paused;
- read-only: a persistent lease label.

Steady saved/synced/live states remain visually quiet but available to assistive
technology. Deviations become visible. Remote editing always commits locally
first; reconnect uses version-vector catch-up and then drains the durable outbox
in order. A server epoch replacement is handled inside the Worker: it validates
the replacement checkpoint, rebases durable unacknowledged intent, atomically
swaps IndexedDB Base+Tail, and only then publishes the new canonical core.
Cursor and selection presence uses expiring protocol messages and is never
written to Loro or IndexedDB. Remote text refresh transforms the local selection
before the authoritative value replaces the editor draft.

## Frontend Boundaries

```text
app/                composition, routing, lifecycle
features/           graph, outline, query, task, settings, and navigation UI
features/commands/  registry, bindings, arbitration, palette, shortcut sheet
features/history/   semantic undo/redo routing and reveal coordination
features/markdown/  safe block and compact Markdown reading projections
features/notify/    transient failure reporting
features/sync/      remote API, credentials, transport, membership, presence
entities/           view models and browser-local settings
core-port/          session, command builders, DTO mapping, graph lease/directory
generated/          generated CorePort types
i18n/               typed catalogs, locale runtime, Intl formatters
lib/                framework-agnostic helpers
ui/                 design tokens, one anchored-panel placement, shared primitives
```

Features depend inward on entities, CorePort, i18n, lib, and UI. Cross-feature
actions are domain commands, app navigation, or narrow context interfaces—not a
shared mutable graph store.

`entities/settings.ts` owns the browser-local preference blob: appearance,
locale, journal timezone/date format, shortcut overrides, and the presentation
preferences that tint the outline thread and the task moment chips. Graph display
names belong to the browser graph directory; graph content and metadata belong
to the core.

A colour preference stores the *name* of a tone declared in `ui/app.css`, never a
colour. The surface carries that name as a `data-palette` attribute and CSS resolves
it, which keeps every preference inside the committed palette and its measured
contrast in both modes; no presentation preference reaches CorePort or the graph.
`features/settings/preferences.ts` is the React side of the same store, so a
preference edited in the dialog reaches the outline in the same commit.

Shared saved-view definitions — their column layout and the order the reader put
the rows in — and the graph's default view belong to the query document, as does
the builder plan behind a built query. A person's last-opened view remains
browser-local until a separate user-private preference sync unit exists. Query
results, selection, scroll, loading state, and drafts are session-only, as is a
sort chosen on a graph the reader cannot write to.

The presentation layer uses Tailwind CSS v4 and shadcn/Radix primitives over the
tokens in `ui/app.css`. Theme resolution is CSS-first, with a pre-paint script
applying an explicit stored choice before React mounts. Portals share one z-index
scale, and motion follows the closed vocabulary in DESIGN.md.

Headless libraries supply models, never appearance: `@tanstack/react-virtual`
for the outline's row windowing and `@tanstack/react-table` for the result
table's ordering, sizing, and sorting models. Every element they drive is
rendered by this codebase against `ui/app.css`, so no library stylesheet is
loaded and no component arrives with its own look.

## Accessibility and Verification

- The outline exposes multi-selectable tree semantics and keyboard navigation.
- Every context-menu verb also has a keyboard or command-palette route.
- Focus and structural selection are keyed by stable IDs across virtualization
  and authoritative refreshes. A focused row is scrolled into view only when it
  is not already visible: a block whose result outgrows the viewport cannot be
  aligned without moving the page under the caret the pointer just placed.
- Property editors stay associated with their owning page or block and return
  focus after a command.
- Component tests use a fake CorePort; layout and browser-storage behavior use
  Playwright; Rust owns domain and query semantics.
- Native and browser adapters consume the same current CorePort fixture and
  round-trip built-in, repeated, and unknown property values.
