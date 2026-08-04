# Client Application Architecture

## Shared Application

The client is a React and TypeScript single-page application bundled by Vite.
The current Step 4 application runs in the browser. Later Tauri shells reuse the
same components and interaction model on macOS and Android; responsive layout
and capability detection replace platform forks.

React owns transient presentation state only: focus, selection, open panels,
optimistic text composition, and viewport caches. Canonical block Markdown and
page/block property bags live in the Rust graph runtime.

## CorePort

The frontend depends on one asynchronous TypeScript interface, `CorePort`:

```text
open/close graph
execute domain command
read page/block view
compile/execute/subscribe query
subscribe graph/save/sync status
import/export graph
```

Request, response, event, and error types are generated from a shared schema.
Contract version negotiation happens on startup. No component calls Tauri APIs,
WebAssembly exports, IndexedDB, or WebSocket directly.

CorePort version 1 fixes `open_graph`, `execute`, `read`, `subscribe`, and
`close_graph`. Generated Rust/TypeScript DTOs cover locators, recovery and
storage capabilities, saved/dirty state, bounded cursors, and stable timeout,
schema, storage, and handle errors. Native and Worker suites consume one golden
transcript.

### Native Adapter (headless parity only at Step 4)

In the later native clients, `CorePort` invokes Tauri commands implemented by
`platform-native`. The graph runtime, SQLite repository, and sync transport run
in the native Rust process. A bounded event channel forwards semantic events to
the webview. Tauri capabilities allow only the explicit commands needed by the
app.

The current headless `NativeCorePort` owns a graph-handle map and one SQLite profile
database. Opening replays verified records; clean close writes a checkpoint and
compaction marker. This adapter is exercised headlessly before editor UI work.

### Browser Adapter

The browser adapter starts the Rust/Wasm graph runtime in a dedicated Web
Worker. `CorePort` messages cross a typed worker protocol; transferable
`ArrayBuffer`s carry large CRDT/archive payloads. IndexedDB and browser
WebSocket implementations satisfy core ports through thin Wasm-facing adapters.
Keeping the runtime off the main thread protects typing, scrolling, and
rendering latency.

The product Worker lazily initializes Wasm only for graph operations; graph
listing and deletion use IndexedDB without paying Wasm startup cost. It owns
the Wasm core, IndexedDB transactions, pending unsaved bytes,
and event cursor. Main-thread callers see immutable DTOs, and large diagnostic
buffers transfer rather than clone. Opening a local locator creates no network
transport.

Beyond the five CorePort v1 operations, the worker protocol carries three
adapter-level operations the local Web app needs: `retry_pending` (persist the
exact pending update bytes after a storage failure), `list_graphs` (stored
graph metadata), and `delete_graph` (explicit local deletion of a closed
graph). They are adapter concerns, not CorePort contract surface. Graph
display names are app-level bookkeeping in a small localStorage directory;
canonical note data never lives there. A `GraphSession` on the main thread
serializes commands, and after every command drains the event stream and
re-reads the authoritative snapshot — the UI has no other state path.

Production uses the wall clock and exposes no verification route or storage
fault controls. A separate Vite `test` mode adds a lazily loaded verification
page, deterministic time, and a `TestCoreWorker`; those symbols and the golden
transcript are test-harness inputs rather than public assets.

## Editor State and Input

Each rendered block has a stable `BlockId`. The editor maintains a viewport
window and requests nearby ancestors/children rather than materializing the
whole graph.

Text input follows this sequence:

1. preserve native IME composition locally;
2. submit an edit with block ID and text-range intent at a composition boundary
   or short debounce;
3. reconcile with the authoritative semantic event from the core;
4. transform the local selection when remote text changes arrive.

Structural commands such as indent, outdent, and move go directly to the core
and render optimistically only when the inverse is known. A rejected command
restores the authoritative subtree and retains focus where possible.

The one optimistic structure is block insertion: Enter mounts a focused
pending row immediately so fast typing lands in the new block, and the row
swaps to its real `BlockId` from the reconciled session snapshot when the core
acknowledges the insert. The handoff restores focus during the same layout
commit, so a parent render lag cannot expose an unfocused or missing editor to
the next input event. Pending rows may chain; queued inserts, indent/outdent
intents, and raced keystrokes replay in order against real ids. Only one
pending handoff dispatches at a time, and the next insert derives its parent
and index after the preceding structural intents reconcile. The known inverse
(drop the row) applies if an insert is rejected. Text drafts are dropped only
once the authoritative snapshot matches them, so debounced splices are never
lost.

## Property-Driven Features

All non-Markdown controls use the same property read/write contract. A versioned
renderer registry maps well-known keys to richer UI without hiding their uniform
representation:

- `tag` renders page autocomplete and repeatable chips;
- `query.source` renders the query editor and result view;
- `task.status` renders workflow controls;
- `task.scheduled` and `task.deadline` render date controls;
- `task.priority` renders priority controls;
- unknown keys fall back to the generic typed property editor.

Removing a feature renderer never makes data unreadable: its values remain
visible and editable as ordinary properties. A new non-text feature adds
property definitions and renderers, not a frontend entity store or core storage
shape.

## Command Layer

Persistent chrome is deliberately small (see [`DESIGN.md`](../DESIGN.md)
§ Disclosure), and the command layer is what makes that safe rather than merely
sparse. `features/commands/` owns one registry, one window keydown listener, the
`⌘K` palette, and the `⌘/` sheet generated from the same registry.

Every registry entry carries a `pointerRoute` describing how a user who never
learns a shortcut reaches that verb; the field is required by the type, so the
palette can never become the only way to do something.

Key arbitration order is fixed: an IME-composition guard first (a composition
owns the keyboard outright — losing a keystroke corrupts CJK input), then any
handler that already called `preventDefault` (the outline's editor bindings, an
open overlay), then the global layer. **The global layer only matches bindings
carrying ⌘ or ⌃**, so no bare key can be taken from a text field.

The shell publishes two slots — block properties and page properties — that the
Outliner and PageView fill while mounted, so `⌘⇧P` reaches a panel that lives
below the shell. Each of those panels also has a local pointer route that works
with no shell present, which is what keeps them reachable in the component test
harness.

## Navigation and Journals

- The application resolves “today” with the user's configured IANA timezone and
  calls `EnsureJournal(LocalDate)`; the core guarantees idempotence.
- Routes use stable page IDs. Human-readable titles are optional route hints,
  not identity.
- Page/tag autocomplete searches the core's page index and writes page-reference
  properties.
- Journal date entry is a palette concern: the palette parses natural-language
  dates (`tomorrow`, `aug 5`, `2026-08-05`, `next monday`) in the same input used
  to search. The day view keeps a mounted, focusable native date input as the
  keyboard route and the `showPicker()` target, without restating the date beside
  a heading that already spells it out.
- Deleted or missing references open a tombstone view rather than silently
  creating a replacement page.

## Offline and Sync UX

The UI distinguishes three independent states:

- **saved locally:** the latest local update is durable;
- **synced remotely:** the service acknowledged all current outbox updates;
- **live:** a real-time connection currently exists.

Loss of connectivity changes only the latter two. Editing remains available, and
the outbox retries with bounded exponential backoff and jitter. Authentication
expiry pauses remote exchange without invalidating the local replica.
Conflict-free merge is normal and is not presented as an error; quarantined data
or failed schema migration is.

## Platform Lifecycle

### Web

- The app is deployable as static assets (hash routing, no rewrite rules) with
  a build-generated Service Worker that precaches the shell — HTML, JS, CSS,
  and the Wasm core — so an offline reload boots. It never caches graph data.
- IndexedDB persistence permission/quota is checked and visible to the user in
  settings, together with quarantined-record recovery reports.
- Multi-tab graph editing uses a per-tab random Loro peer ID and a Web Locks
  lease per graph; without the lease, a second tab opens the graph read-only.
  A tab-local coordinator serializes transient session replacement onto the
  same lease, so development remounts cannot impersonate a competing tab.
  Session shutdown is cancellation-safe, and peer IDs are never reused
  concurrently.

### macOS (planned)

- Window/menu/shortcut integration lives in Tauri-specific modules.
- App suspension/quit requests a bounded core flush and shows unsaved failures.
- Packaging, signing, notarization, and updater configuration are delivery
  concerns, not domain code.

### Android (planned)

- Back navigation, soft keyboard, safe areas, sharing intents, and lifecycle
  events are adapter concerns.
- Background execution is opportunistic. The core flushes locally on pause and
  sync resumes on foreground; correctness never depends on a permanent
  background socket.
- Touch targets and outline gestures provide keyboard-command equivalents
  without changing command semantics.

## Frontend Module Boundaries

```text
app/             composition, routing, lifecycle
features/        editor and property-driven journal/query/task/graph views
features/commands/  the command layer: registry, key arbitration, palette, sheet
entities/        page/block view models and renderers
core-port/       session, commands, snapshot DTOs, graph directory, lease
generated/       CorePort contract types (path fixed by the drift check)
lib/             framework-agnostic UI helpers (class-name merge)
ui/              design tokens, Tailwind v4 theme, appearance, shadcn/Radix primitives
```

The presentation layer is Tailwind CSS v4 with shadcn/ui primitives built on
Radix, over the token set in `ui/app.css`. That file is the single owner of every
design token; `ui/globals.css` declares the cascade order
(`theme, base, neoseq, components, utilities`), imports `app.css` into the
`neoseq` layer so a utility can still win, and maps the tokens onto shadcn's
semantic variables — it declares no values of its own. [`DESIGN.md`](../DESIGN.md)
is the design source of truth, including a committed ink-versus-surface contrast
table that components are expected to consult rather than re-derive.

Both colour modes ship from one declaration and resolution is **CSS-only**: an
explicit `[data-theme]` on the root beats the `prefers-color-scheme` query in
both directions, and a pre-paint inline script in `index.html` applies a stored
choice. `ui/theme.ts` records the preference and never asks the browser what mode
it is in, so a runtime without `matchMedia` still renders correctly.

Native form controls stay native (select, checkbox, date) for platform pickers
and AT support. Overlays that must escape the virtualized outline's scroll
container and stacking context — the block action menu and the page autocomplete
— render in portals, on one shared `--z-*` scale. Motion is deliberately
restrained: **every** entrance animates opacity only and nothing animates a
transform, so a surface is never contrast-unsafe while an audit reads it and
never moves while a pointer travels toward it.

The property registry the UI validates against is imported from the versioned
core fixture (`fixtures/core/property-definitions-v1.json`), so client and
core share one definition source.

Feature modules may depend on `entities`, `core-port`, and `ui`; reverse imports
are forbidden. Cross-feature actions are domain commands or app-level
navigation, not shared mutable stores.

## Accessibility and Testing

- The outline exposes tree/treeitem semantics, depth, expansion, and keyboard
  navigation, including `ArrowLeft`/`ArrowRight` collapse-and-step so no
  affordance is pointer-only; query results use appropriate list/table semantics.
- Property editors are progressive: both page bags live in one disclosure between
  the title and the writing, reached from the property strip, the page menu, or
  `⌘⇧P`. System-owned keys are page *information* and surface in the page-info
  dialog, not in the property list. Nothing is mounted below the outline.
- Focus and selection survive virtualization and remote updates by stable IDs.
- Component tests use a fake `CorePort`; they do not instantiate Loro.
- Contract suites run against both native and worker adapters and verify that
  well-known, repeated, and unknown properties round-trip without loss.
- Current end-to-end suites cover the local Web product and offline restart.
  Later suites add reconnect/merge, Android lifecycle, and macOS navigation as
  those deployment units are implemented.

Tauri 2 is selected because its maintained architecture supports web frontends
with Rust commands and packaging for both
[macOS and Android](https://v2.tauri.app/distribute/).
