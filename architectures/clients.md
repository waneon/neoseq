# Client Application Architecture

## Shared Application

The client is a React and TypeScript single-page application bundled by Vite.
The same components and interaction model run in the browser and Tauri 2
webviews on macOS and Android. Responsive layout and capability detection
replace platform forks; platform-specific code is isolated behind adapters.

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

### Native Adapter

On macOS and Android, `CorePort` invokes Tauri commands implemented by
`platform-native`. The graph runtime, SQLite repository, and sync transport run
in the native Rust process. A bounded event channel forwards semantic events to
the webview. Tauri capabilities allow only the explicit commands needed by the
app.

### Browser Adapter

The browser adapter starts the Rust/Wasm graph runtime in a dedicated Web
Worker. `CorePort` messages cross a typed worker protocol; transferable
`ArrayBuffer`s carry large CRDT/archive payloads. IndexedDB and browser
WebSocket implementations satisfy core ports through thin Wasm-facing adapters.
Keeping the runtime off the main thread protects typing, scrolling, and
rendering latency.

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

## Navigation and Journals

- The application resolves “today” with the user's configured IANA timezone and
  calls `EnsureJournal(LocalDate)`; the core guarantees idempotence.
- Routes use stable page IDs. Human-readable titles are optional route hints,
  not identity.
- Page/tag autocomplete searches the core's page index and writes page-reference
  properties.
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

- The app is deployable as static assets with a Service Worker for shell
  caching.
- IndexedDB persistence permission/quota is checked and visible to the user.
- Multi-tab graph editing requires a per-tab Loro peer ID and a coordination
  lease; without a lease, a second tab opens the graph read-only. Peer IDs are
  never reused concurrently.

### macOS

- Window/menu/shortcut integration lives in Tauri-specific modules.
- App suspension/quit requests a bounded core flush and shows unsaved failures.
- Packaging, signing, notarization, and updater configuration are delivery
  concerns, not domain code.

### Android

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
entities/        page/block view models and renderers
core-port/       generated contracts and native/browser adapters
ui/              reusable presentational components and design tokens
```

Feature modules may depend on `entities`, `core-port`, and `ui`; reverse imports
are forbidden. Cross-feature actions are domain commands or app-level
navigation, not shared mutable stores.

## Accessibility and Testing

- The outline exposes tree/treeitem semantics, depth, expansion, and keyboard
  navigation; query results use appropriate list/table semantics.
- Focus and selection survive virtualization and remote updates by stable IDs.
- Component tests use a fake `CorePort`; they do not instantiate Loro.
- Contract suites run against both native and worker adapters and verify that
  well-known, repeated, and unknown properties round-trip without loss.
- End-to-end suites cover IME, offline restart, reconnect/merge, deep outlines,
  property-driven task/query controls, Android lifecycle, and macOS keyboard
  navigation.

Tauri 2 is selected because its maintained architecture supports web frontends
with Rust commands and packaging for both
[macOS and Android](https://v2.tauri.app/distribute/).
