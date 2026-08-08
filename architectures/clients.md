# Client Application Architecture

## Scope

The current client is a React and TypeScript single-page application bundled by
Vite. It runs the Rust graph core as WebAssembly in a dedicated Worker and uses
IndexedDB for local persistence. React owns presentation state—focus, selection,
open layers, composition buffers, and optimistic rows—while the Rust runtime
owns canonical graph state.

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

`GraphSession` serializes commands. After a command it drains semantic events,
refreshes the graph summary, and rehydrates affected pages. It owns subscription
cursors and turns an ambiguous storage failure into a retry of the exact pending
update. Callers see immutable DTOs and cannot hold a Loro container.

## Browser Adapter

`core-worker.ts` implements CorePort messaging on the main thread;
`graph-worker.ts` owns Wasm and persistence. Transferable `ArrayBuffer`s carry
binary CRDT or archive data without cloning. Wasm initializes only when a graph
opens, so graph listing and deletion do not pay core startup cost.

The production build uses the wall clock and ordinary adapter operations. Vite
test mode adds a storage contract page, deterministic time, and explicit fault
controls. Those controls and the current CorePort corpus are test-only chunks,
not public product routes.

Graph display names are browser-level directory metadata in localStorage.
Canonical note data remains in the Loro repository. A Web Lock grants one tab a
writable lease per graph; a competing tab is read-only.

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

Enter is one atomic `split_block` command. A pending row mounts immediately so
fast typing has a focus target, then swaps to the real block ID during
reconciliation. Pending rows may chain; queued structural intents replay in
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

- `builtin.query-source` provides a SPARQL editor and result view;
- `builtin.task-*` provides workflow, priority, and date controls;
- registered lifecycle and page built-ins appear as read-only page information;
- unknown `user.*` keys use the generic typed editor, while unknown
  `builtin.*` keys are rendered generically but remain read-only;
- tag membership remains a separate structural picker.

Removing a specialized renderer never hides or destroys its values. New
non-structural features add registry entries and projections, not frontend data
stores or new CRDT roots.

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

`features/notify/` owns one toast queue. Rejected actions without a persistent
home report there; durability stays in the save slot, field validation stays by
the field, and query errors stay in the query block. Stable CorePort errors map
to localized messages while raw internal detail stays off screen.

## Offline State

The current client exposes local durability only:

- saved: no persistent mark;
- saving: a delayed quiet indicator;
- unsaved: a persistent error reason and retry action;
- read-only: a persistent lease label.

Remote connection and acknowledgement states will be added with the sync agent.
They must remain distinct from local durability so network loss never looks like
lost local work.

## Frontend Boundaries

```text
app/                composition, routing, lifecycle
features/           graph, outline, query, task, settings, and navigation UI
features/commands/  registry, bindings, arbitration, palette, shortcut sheet
features/notify/    transient failure reporting
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

The presentation layer uses Tailwind CSS v4 and shadcn/Radix primitives over the
tokens in `ui/app.css`. Theme resolution is CSS-first, with a pre-paint script
applying an explicit stored choice before React mounts. Portals share one z-index
scale, and motion follows the closed vocabulary in DESIGN.md.

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
