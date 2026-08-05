# Client Application Architecture

## Shared Application

The client is a React and TypeScript single-page application bundled by Vite. Step 5
runs in the browser; later Tauri shells reuse the same components and interaction
model on macOS and Android, with responsive layout and capability detection replacing
platform forks. React owns transient presentation state only — focus, block selection,
open panels, optimistic text composition, viewport caches — while canonical block
Markdown and property bags live in the Rust graph runtime, and UI localization follows
the device-local [`LocaleRuntime`](i18n.md) without ever translating graph data.

## CorePort

The frontend depends on one asynchronous TypeScript interface, `CorePort`:

```text
open/close graph
execute domain command
read page/block view
compile/execute/subscribe read-only SPARQL query
subscribe graph/save/sync status
import/export graph
```

Request, response, event and error types are generated from a shared schema, and
version negotiation happens on startup. No component calls Tauri APIs, WebAssembly
exports, IndexedDB or WebSocket directly.

Version 5 makes plural structural commands the single path for both one-block and
multi-block edits; version 4 added `query` alongside the six existing operations. The generated DTOs and
the stable error set are defined in [`contracts/core-port.json`](../contracts/core-port.json),
which both the Native and Worker suites consume as a fixture.

### Native Adapter (headless parity only at Step 5)

In the later native clients, `CorePort` invokes Tauri commands implemented by
`platform-native`: the graph runtime, SQLite repository and sync transport run in the
native Rust process, a bounded event channel forwards semantic events to the webview,
and Tauri capabilities allow only the commands the app needs. The current headless
`NativeCorePort` owns a graph-handle map and one SQLite profile database; opening
replays verified records, and a clean close writes a checkpoint and compaction
marker.

### Browser Adapter

The browser adapter starts the Rust/Wasm graph runtime in a dedicated Web Worker,
keeping typing, scrolling and rendering latency off the runtime's path. `CorePort`
messages cross a typed worker protocol, transferable `ArrayBuffer`s carry large
CRDT/archive payloads, and IndexedDB and browser WebSocket implementations satisfy
core ports through thin Wasm-facing adapters.

The Worker owns the Wasm core, IndexedDB transactions, pending unsaved bytes and the
event cursor, and initializes Wasm lazily — graph listing and deletion pay no startup
cost. Main-thread callers see immutable DTOs; large diagnostic buffers transfer rather
than clone, and opening a local locator creates no network transport.

Beyond the seven CorePort v5 operations the protocol carries three adapter-level
ones — `retry_pending` (persist the exact pending update bytes after a storage
failure), `list_graphs`, `delete_graph` — which are adapter concerns, not contract
surface. Graph display names are app-level bookkeeping in a small localStorage
directory; canonical note data never lives there. A `GraphSession` on the main thread
serializes commands and, after each one, drains the event stream, refreshes the graph
summary and rehydrates only the affected page, never copying unrelated outlines
across the Worker boundary.

Production uses the wall clock and exposes no verification route or storage fault
controls. A separate Vite `test` mode adds a lazily loaded verification page,
deterministic time and a `TestCoreWorker` — test-harness inputs, not public assets.

## Editor State and Input

Each rendered block has a stable `BlockId`. The editor keeps a viewport window and
requests nearby ancestors/children rather than materializing the whole graph.

The outline holds two mutually exclusive notions of "current": a caret (a focused
textarea) and a structural selection (a set of `BlockId`s a bulk command acts on).
Taking either drops the other — a gesture that selects also blurs the textarea — so
a bare `⌫` is never ambiguous. Selection arithmetic (which rows a drag covers, which
are the roots of the moved subtrees, where a drop legally lands) is pure, lives in
`features/outline/selection.ts`, and is addressed by row *index* rather than by
rectangle, because virtualized rows a marquee never mounted must still be
selectable. A range drag may start on a quiet row surface or in the page margin while
an already-focused textarea keeps native text selection. Bulk move, indent, outdent and delete cross the boundary as one command
per selected gesture. Single-block actions use the same plural command with one ID.
The client resolves visible selection roots and a geometric drop destination;
the core normalizes ancestors/descendants, derives authoritative operation order,
preflights the complete hierarchy change, and owns its transaction and undo group.

Structural clipboard data uses portable plain-text Markdown list items. The client
serializes the visible selection with normalized relative depth and parses only text
that is unambiguously a Markdown list; ordinary multiline text stays inside the active
block. Parsed items cross the boundary in one `insert_outline` command, which validates
the pre-order depth shape, optionally reuses an empty target, creates the hierarchy,
and owns one undo group. Clipboard contents never enter diagnostic records.

Text input follows one sequence: preserve native IME composition locally; submit an edit
with block ID and text-range intent at a composition boundary or short debounce; reconcile
with the authoritative semantic event from the core; transform the local selection when
remote text arrives. A press that begins while something floats over the page only dismisses
it — the empty region below the writing is also the append target — sampled at the `window`
in the capture phase, before Radix removes the layer being asked about.

Structural commands go directly to the core and render optimistically only when the
inverse is known. A rejected one restores the authoritative subtree, keeps focus where
it can, and is reported (§ Failure Reporting) rather than looking like a dead key.

The one optimistic structure is block insertion: Enter mounts a focused pending row
so fast typing lands in the new block, and it swaps to its real `BlockId` in the
same layout commit that the core's acknowledgement reconciles, so a render lag
cannot expose an unfocused editor to the next keystroke. Pending rows chain —
queued inserts, indent/outdent intents and raced keystrokes replay in order against
real ids, one handoff at a time. A rejected insert applies the known inverse; text
drafts are dropped only once the authoritative snapshot matches them.

## Property-Driven Features

Extensible metadata controls use the property read/write contract; a versioned renderer
registry maps well-known keys to richer UI without hiding their uniform representation.
`tag_refs` renders tag-registry autocomplete and repeatable chips (tag membership being
the explicit structural exception); `query.source` renders the SPARQL editor and result
view; `task.*` keys render workflow, priority and date controls;
`system.created-at`/`system.updated-at` render as read-only page info; unknown keys fall
back to the generic typed editor.

Removing a renderer never makes data unreadable — its values stay visible and
editable as ordinary properties — and a new non-text feature adds property
definitions and renderers, not a frontend entity store or a core storage shape.

The query editor executes stored SPARQL and reports typed rows, booleans and
diagnostics; runtime values are sent as typed initial bindings, never interpolated
into source text. Global search already uses generated SPARQL through the same
CorePort operation, and task lists, agendas, backlinks and editor completion extend
that operation rather than add graph-scan APIs.

## Command Layer

Persistent chrome is deliberately small (see [`DESIGN.md`](../DESIGN.md) § Disclosure),
and the command layer is what makes that safe rather than merely sparse.
`features/commands/` owns one registry, one window keydown listener, the `⌘K` palette, and
the `⌘/` sheet generated from the same binding table. Each entry carries a localized
pointer route; the palette's own is the rail's permanent `Search` row, which is what lets
undo and redo give up their top-bar buttons.

`commands/shortcuts.ts` owns the binding table — defaults, stored overrides, validation,
display form. A `Binding` cannot express a modifier-less shortcut, so the "⌘ or ⌃ only"
invariant is a type rather than a check; one hook resolves the table, so listener, sheet,
settings editor, menu rows and palette badges agree by construction. Bindings persist as
`event.key`; the display form is a *sequence* of parts (`formatBindingParts`) that `ui/kbd`
lays out one column per key and `formatBinding` joins for a name. The outline's writing keys
are not in the table and not rebindable, and the top bar's `⋯` is generated from the registry
so every row carries the palette's own label, icon, badge and reason for that verb.

Key arbitration order is fixed: an IME-composition guard first (a composition owns the
keyboard outright — losing a keystroke corrupts CJK input), then any handler that already
called `preventDefault` (the outline's editor bindings, an open overlay), then the global
layer. A modal surface stands the global layer down while it is up, so the palette can
never be summoned over a focus-trapping dialog that would take its input's focus back.

The shell publishes slots the routed views fill while mounted — block properties, page
properties, and the page's own info/delete verbs — so `⌘⇧P` and the palette reach panels
and menus that live below the shell. Each also has a local pointer route that works with
no shell present, which is what keeps them reachable in the component test harness.

## Failure Reporting

`features/notify/` owns one toast queue above the router, so reports survive navigation
and reach the shell-less picker; a default no-op `Notifier` lets features mount bare in
tests. **Every rejected command is reported through this one layer** — structural key,
rename, autocomplete pick, page restore, task field, query source, graph search alike:
one surface, one copy contract, one place to look. The narrow exclusions are durability
(`dirty_unsaved` and `storage_full` stay in the save slot), field validation, and query
diagnostics, which remain beside the input or query block that owns them.

Every report expires with a countdown that pauses while the user is looking at it. `errors.ts`
maps safe, stable errors to localized messages; raw diagnostics stay off screen.

`features/diagnostics/` records content-free state relationships or explicitly consented enhanced content without expanding `CorePort`; [diagnostics.md](diagnostics.md) owns the privacy contract.

## Navigation and Journals

- The application resolves “today” with the user's configured IANA timezone and calls
  `EnsureJournal(LocalDate)`; the core guarantees idempotence. How a day is *written* is a
  separate app-wide preference read from `entities/settings`, so the journal title, the top
  bar and the palette can never disagree.
- Routes use stable page IDs; human-readable titles are hints, not identity.
  Settings is a dialog whose open section lives in a search parameter, so it is
  linkable and the browser's Back closes it.
- Page and tag creation uses the core's case/whitespace name identity: the
  autocomplete reuses an exact normalized match, default creation chooses the next
  available `Untitled N`, and a rejected rename stays on the authoritative title and
  is reported. Page-reference autocomplete searches the page summary; tag
  autocomplete searches the independent tag registry and writes `TagId` membership.
- Journal date entry is a palette concern: an injected locale adapter parses
  locale-specific words and month/weekday names, while ISO `2026-08-05` works in every
  locale. The day view keeps a mounted, focusable native date input as the keyboard
  route and `showPicker()` target, without restating the date beside a heading that
  already spells it out.
- Deleted or missing references open a tombstone rather than silently creating a
  replacement.

## Offline and Sync UX

Three independent states: **saved locally** (the latest update is durable), **synced
remotely** (the outbox is acknowledged), **live** (a connection exists). Losing
connectivity changes only the latter two; editing continues, the outbox retries with
bounded backoff and jitter, and authentication expiry pauses remote exchange without
invalidating the local replica. Conflict-free merge is not an error; quarantined data
or a failed schema migration is.

## Platform Lifecycle

### Web

- Deployable as static assets (hash routing, no rewrite rules) with a build-generated
  Service Worker precaching the shell — HTML, JS, CSS, Wasm core — so an offline reload
  boots. It never caches graph data.
- IndexedDB persistence permission and quota are visible in Settings → Storage, and
  quarantined-record recovery is reported once and kept in Settings → Graph.
- Multi-tab editing uses a per-tab random Loro peer ID and a Web Locks lease per
  graph; without the lease a second tab opens read-only. A tab-local coordinator
  serializes transient session replacement onto the same lease, so development
  remounts cannot impersonate a competing tab; shutdown is cancellation-safe and
  peer IDs are never reused concurrently.

### macOS and Android (planned)

Window/menu/shortcut integration, back navigation, soft keyboard, safe areas, sharing
intents and lifecycle events are Tauri-specific adapter concerns, as are packaging,
signing, notarization and the updater. Suspension or quit requests a bounded core
flush and shows unsaved failures; background execution is opportunistic, so the core
flushes locally on pause and sync resumes on foreground and correctness never depends
on a background socket. Touch targets and outline gestures provide keyboard-command
equivalents without changing command semantics.

## Frontend Module Boundaries

```text
app/             composition, routing, lifecycle
features/        editor and property-driven journal/query/task/graph/diagnostic views
features/commands/  the command layer: registry, bindings, arbitration, palette, sheet
features/notify/    the notification layer: toast queue, failure copy, viewport
features/settings/  the two-scope settings dialog and the shortcut editor
entities/        page/block view models, and the browser-local settings store
core-port/       session, commands, snapshot DTOs, graph directory, lease
generated/       CorePort contract types (path fixed by the drift check)
i18n/            locale resolution, typed catalogs, provider, Intl formatters
lib/             framework-agnostic UI helpers (class-name merge)
ui/              tokens, theme, appearance, brand, shadcn/Radix, and the shared
                 `kbd` / `menu-select` / `auto-height` primitives
```

`entities/settings.ts` is the single owner of the browser-local preference blob
(`neoseq.settings.v1`): journal timezone, UI locale, journal date format, shortcut
overrides. It keeps one parsed snapshot and publishes changes, which is what lets a
date-format or shortcut edit take effect live and agree across tabs;
`entities/journal.ts`, `i18n/runtime.tsx` and `features/commands/shortcuts.ts` read it
through this store rather than each keeping their own read-modify-write pair. Settings
belonging to a *graph* stay where they were — the graph directory for its display name
(which now publishes too, so a rename cannot leave two names on screen), the core for
everything else.

The presentation layer is Tailwind CSS v4 with shadcn/ui primitives on Radix, over
the token set in `ui/app.css` — the single owner of every design token.
`ui/globals.css` declares the cascade order and maps those tokens onto shadcn's semantic
variables, declaring no values of its own. [`DESIGN.md`](../DESIGN.md) is the design
source of truth, including a committed contrast table components consult rather than
re-derive.

Both colour modes ship from one declaration and resolution is **CSS-only**: an
explicit `[data-theme]` beats `prefers-color-scheme` in both directions, and a
pre-paint script in `index.html` applies the stored choice. `ui/theme.ts` records
the preference and never asks the browser, so a runtime without `matchMedia` still
renders correctly.

Checkbox and date inputs stay native for the platform picker; a *list of choices* does not,
because a `<select>`'s popup is drawn by the operating system and no token can reach it, so
`ui/menu-select` renders every one as the same Radix menu the block menu is. Anything that
must escape the virtualized outline's scroll container and stacking context — the block menu,
the page autocomplete, the notification viewport — renders in a portal on one shared `--z-*`
scale, and both context menus hang off the object they act on (a bullet is a real trigger;
the title row positions against a zero-size anchor at the pointer). Motion's vocabulary is
closed: `opacity` for entrances and view swaps, a box's own **size** (`height`, and the
rail's grid track) when its content is swapped, and one rotation — the collapse chevron.
Nothing animates a transform, and a surface read the moment it appears carries no entrance,
so an audit never reads one mid-fade; `ui/auto-height` measures through a `ResizeObserver`
and transitions to what it found. Both trades are argued in
[`DESIGN.md`](../DESIGN.md) §§ Choice, Motion.

The property registry the UI validates against is imported from the versioned
core fixture (`fixtures/core/property-definitions-v3.json`), so client and core
share one definition source. Features depend inward on `entities`, `core-port`,
`i18n`, and `ui`; reverse imports are forbidden. Cross-feature actions are domain
commands, app-level navigation, or a layer provided through context —
never a shared mutable store.

## Accessibility and Testing

- The outline exposes accessible multi-selectable tree semantics and keyboard
  collapse-and-step; query results use list/table semantics. Every verb on a
  context menu is also a documented key or a palette row, so no capability depends
  on a right-click.
- Property editors are progressive: both page bags live in one disclosure between the
  title and the writing, reached from the strip, the title row's menu, or `⌘⇧P`.
  System-owned keys are page *information* and live in the page-info dialog, and nothing
  is mounted below the outline.
- Focus and selection survive virtualization, remote updates and reports, by ID.
- Component tests use a fake `CorePort` and never instantiate Loro; selection arithmetic
  and the binding table are pure and tested directly, while the marquee needs real layout
  and belongs to the browser suite.
- Contract suites run against both adapters and verify that well-known, repeated and
  unknown properties round-trip without loss. End-to-end suites cover the local Web
  product, offline restart, and a real core rejection reported live — audited while the
  toast is up, in both colour schemes.

Tauri 2 is selected because its maintained architecture supports web frontends with Rust
commands and packaging for both [macOS and Android](https://v2.tauri.app/distribute/).
