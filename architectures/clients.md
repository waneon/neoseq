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
deletion, pending-write retry, storage capabilities, and test fault controls are
adapter operations outside the portable product contract.

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

The outline has two mutually exclusive interaction modes: a text caret in one
editor or structural selection of block IDs. Taking one clears the other so text
deletion and subtree deletion cannot be confused. Pure selection arithmetic
lives in `features/outline/selection.ts`; browser tests own geometry-dependent
marquee and drag behavior.

IME composition remains local until a composition boundary. Normal typing uses
a short debounce, submits block ID plus text-range intent, then reconciles with
the authoritative core event while preserving the selection. Structural commands
cross CorePort immediately and may render optimistically only when the inverse
is known.

Enter is one atomic `split_block` command; on an empty block it is instead an
insert below, so the caret always lands on the new line. A pending row mounts
immediately so fast typing has a focus target, then swaps to the real block ID
during reconciliation. Pending rows may chain; queued structural intents replay in
order after IDs resolve. Rejection applies the known inverse and retains a draft
until authoritative state agrees.

Bulk move, indent, outdent, and delete send one plural command for the selected
roots. The core removes duplicate descendants, derives authoritative order, and
owns the transaction and undo group. Clipboard structure is portable Markdown
list text; unambiguous lists become one `insert_outline` command, while ordinary
multiline text stays in the editor.

## Property-Driven Features

[`../contracts/property-registry.json`](../contracts/property-registry.json) is
imported directly by the client and Rust domain. Placement access determines
whether a property is hidden, read-only, or editable. Sparse renderer maps add
specialized controls without becoming a schema authority:

- `builtin.query` provides the query builder, a SPARQL escape hatch, and
  schema-owned saved result views. It is authored only through `/`: the generic
  property route never offers it, so a query is never half-created by a picker;
- `builtin.task-*` provides workflow, priority, and date controls;
- registered lifecycle and page built-ins appear as read-only page information;
- unknown `user.*` keys use the generic typed editor, while unknown
  `builtin.*` keys are rendered generically but remain read-only;
- tag membership remains structural: the block `Tags` picker and the outline's
  inline `#` menu attach existing tags (`add_tag`/`remove_tag`), while the
  routed tags view owns the tag lifecycle — creation, deletion, and each tag's
  `defaults` through the shared owner-based property commands.

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

Routes use stable page IDs. Settings is a dialog whose section is represented by
a query parameter, so browser Back closes it without losing editor context.
Journal navigation resolves the user's configured timezone to a `LocalDate` and
asks the core to ensure that deterministic journal.

`features/history/` is the single client coordinator for undo/redo and for
opening one entity by ID. It consumes the core's semantic history effect, chooses
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
features/notify/    transient failure reporting
features/sync/      remote API, credentials, transport, membership, presence
entities/           view models and browser-local settings
core-port/          session, command builders, DTO mapping, graph lease/directory
generated/          generated CorePort types
i18n/               typed catalogs, locale runtime, Intl formatters
lib/                framework-agnostic helpers
ui/                 design tokens and shared primitives
```

Features depend inward on entities, CorePort, i18n, lib, and UI. Cross-feature
actions are domain commands, app navigation, or narrow context interfaces—not a
shared mutable graph store.

`entities/settings.ts` owns the browser-local preference blob: appearance,
locale, journal timezone/date format, and shortcut overrides. Graph display
names belong to the browser graph directory; graph content and metadata belong
to the core.

Shared saved-view definitions, their column layout, and the graph's default view
belong to the query document, as does the builder plan behind a built query. A
person's last-opened view remains browser-local until a separate user-private
preference sync unit exists. Query results, a table's own header sort, selection,
scroll, loading state, and drafts are session-only.

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
  and authoritative refreshes.
- Property editors stay associated with their owning page or block and return
  focus after a command.
- Component tests use a fake CorePort; layout and browser-storage behavior use
  Playwright; Rust owns domain and query semantics.
- Native and browser adapters consume the same current CorePort fixture and
  round-trip built-in, repeated, and unknown property values.
