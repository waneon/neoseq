# Build and Verification Architecture

## Boundary

devenv is the supported environment and command boundary for local development
and CI. `devenv.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin external
resolution. The current build targets are the static Web client, its Rust/Wasm
core, and the Rust synchronization server. Native shells, signing, and release
provenance enter only in the stages that implement them.

The devenv configuration is composed around three developer-facing concerns:

- a shared Rust, Node, pnpm, PostgreSQL, and artifact foundation;
- one pinned repository formatter spanning maintained source, configuration,
  and documentation;
- one supervised development runtime; and
- one verification graph, extended by the optional browser profile.

The browser profile adds Playwright and its isolated collaboration processes.
Database tests use the shared PostgreSQL service but own a temporary database
per suite.

`outputs.web` and `outputs.sync-server` own the deployable artifacts. They build
from Git-tracked sources inside the Nix sandbox with dependencies fetched from
the lockfiles. Fixed-output dependency names include their lockfile digest, so a
lockfile change cannot reuse a previously validated store path. Devenv does not
serve those outputs; its processes own the source-based development runtime,
while tasks own checks and ephemeral database or browser setup. Package scripts
do not define repository-wide build or verification flow.

## Build flow

```text
domain ──> query ──> graph-core ──> platform-web ──> Wasm bindings ──> Web
   │                      │
   └──────────────────────┴──> platform-native / SQLite verification

sync-protocol ──> sync-server ──> PostgreSQL / WebSocket verification
```

The `web` output compiles `platform-web`, generates Wasm bindings, checks the
client, and installs the static site as one Nix store artifact. Production Wasm
uses the `wasm-release` profile with size optimization, LTO, one codegen unit,
aborting panics, and stripped symbols. Development and browser test builds use
the regular release profile for a faster loop.

One generator turns `contracts/` into the Rust and TypeScript sources that must
agree: the CorePort DTOs and error codes, the graph document-schema window, and
the sync protocol version with its WebSocket subprotocol name. The drift check
runs before every other check, so a version bumped in only one language fails
the build instead of the running system.

Normal Vite builds contain product routes and real adapters. Test mode adds the
storage contract page, deterministic time, and injected persistence faults.
Development and test-mode bindings remain checkout-local ignored artifacts;
the production artifact exists only as a Nix output.

The `sync-server` output builds the release service binary and installs it as a
single Nix store artifact. Database migrations are embedded in the binary.
For local development, the supervised sync server waits for the persistent
PostgreSQL service and exposes an HTTP readiness probe. Database-backed tests
share the devenv-managed PostgreSQL service while each suite owns a uniquely
named database.

## Verification

`devenv test` runs the portable gate:

- fixed-output Cargo and pnpm dependency hashes for both production outputs;
- repository-wide formatting, strict Clippy, Rust workspace and PostgreSQL
  integration tests, and dependency policy;
- generated contract and locale drift checks;
- TypeScript and component tests.

Treefmt is the single formatting boundary. It delegates Rust, Nix, Web and
document formats, TOML, and shell scripts to pinned language-native formatters.
Generated sources remain owned by their generators, lockfiles remain owned by
their package managers, and applied SQL migrations remain byte-stable. Running
`treefmt` formats maintained files; the portable gate runs the same formatter
set in CI mode and rejects drift.

`devenv build outputs.web` and `devenv build outputs.sync-server` realize the
production artifacts. Keeping artifact construction separate from tasks makes
it reproducible and cacheable.

`devenv --profile browser test` extends the portable gate with pinned
Chromium-based IndexedDB contracts, parallel desktop E2E, focused mobile and
dark-mode coverage, and a real two-profile collaboration scenario. One managed
preview process owns the profile-allocated Web port, and one Playwright run
schedules every browser project against it.
The gate previews a test-mode artifact built in the same task graph. A direct
Playwright invocation builds that artifact itself, so neither route may reuse a
stale checkout-local site.
The scenario uses a test-only sync-server process with an allocated port and an
isolated database on the managed PostgreSQL service. The profile adds this task
to the shared verification graph and keeps the browser runtime out of the
normal shell. CI runs the extended graph once and uploads checkout-local
Playwright failure artifacts.

## Asynchronous verification

Tests synchronize on observable state transitions, not elapsed wall-clock time.
Local machines and CI runners differ in scheduling, CPU contention, and browser
rendering latency; a fixed delay can conceal a missing causal edge locally and
still expire before that edge in CI. Increasing delays, retries, or serializing
the suite does not establish correctness.

Every asynchronous interaction therefore proves the boundary it depends on:

- a durable mutation captures the saved revision before the user gesture,
  observes a newer revision, and only then accepts the saved state;
- optimistic rows and replaceable controls reach their canonical identity,
  focus, and command-ready state before receiving subsequent input;
- pointer selection begins mutation only after the complete click gesture, and
  overlays capture geometry before a gesture can replace their DOM anchor;
- derived views and geometry converge by polling their semantic result, with
  stability requiring consecutive equal observations when no single completion
  event exists;
- finite UI transitions finish before an action that depends on their final
  hit-testing or layout state.

A component-test interaction owns every React update it starts. External stores
therefore expose a finite completion boundary for application-owned work, and a
fixture settles that work inside the same interaction that changed its input.
Frame-scheduled overlay and focus transitions are likewise awaited at their
frame boundary. React diagnostics for escaped, overlapping, or unawaited
`act()` scopes fail the suite; suppressing them is not a verification strategy.

An already-visible `saved` state is not evidence that a new mutation completed,
and a visible element is not necessarily the reconciled element that will own
the next input. Time-dependent product behavior uses controlled clocks in
component tests. Browser retries are disabled because a second schedule cannot
validate the first. Suite timeouts remain failure budgets only; arbitrary sleeps
must not order test actions.

Workspace tests cover the synchronization protocol and native/WebSocket
convergence behavior. The database task depends on PostgreSQL readiness and
runs the explicitly ignored migration, authorization, idempotency, and fault
integration test against its own database.
Portable checks attach directly to the test entry point. The browser profile
adds its browser task to that same entry point. Browser build prerequisites and
component tests finish before Playwright runs; the managed preview and
collaboration processes both reach readiness first, so browser load cannot
starve component tests.

The Rust, component, IndexedDB, and Web E2E suites cover the remote
collaboration protocol/client contracts, authorization revocation, multi-tab
identity, mocked remote Web UX, durable outbox, and headless convergence
behavior. The collaboration stage additionally verifies a real two-profile
online/offline/reconnect/revocation journey through the assembled system.
