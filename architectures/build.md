# Build and Verification Architecture

## Boundary

devenv is the supported environment and command boundary for local development
and CI. `devenv.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin external
resolution. The current build targets are the static Web client, its Rust/Wasm
core, and the Rust synchronization server. Native shells, signing, and release
provenance enter only in the stages that implement them.

`devenv.nix` intentionally contains only developer-facing concerns:

- the stable Rust toolchain with formatting, Clippy, and the Wasm target;
- Node 22, pnpm 10, `wasm-bindgen`, and dependency-policy tooling;
- supervised Web and sync server development processes;
- a persistent local PostgreSQL service and isolated database-test tooling;
- reproducible production Web and sync server outputs plus the verification task graph;
- an optional profile containing Playwright browsers and their environment.

`outputs.web` and `outputs.sync-server` own the deployable artifacts. They build
from Git-tracked sources inside the Nix sandbox with dependencies fetched from
the lockfiles. Processes and services own the development runtime; tasks own
checks and ephemeral database or browser-test setup. Package scripts do not
define repository-wide build or verification flow.

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
aborting panics, and stripped symbols. Development and browser-test builds use
the regular release profile for a faster loop.

Normal Vite builds contain product routes and real adapters. Test mode adds the
storage contract page, deterministic time, and injected persistence faults.
Development and test-mode bindings remain checkout-local ignored artifacts;
the production artifact exists only as a Nix output.

The `sync-server` output builds the release service binary and installs it as a
single Nix store artifact. Database migrations are embedded in the binary.
For local development, the supervised sync server waits for the persistent
PostgreSQL service and exposes an HTTP readiness probe. The isolated database
test uses a separate temporary PostgreSQL instance.

## Verification

`devenv test` runs the portable gate:

- Rust formatting, strict Clippy, workspace tests, and dependency policy;
- generated CorePort and locale drift checks;
- TypeScript and component tests.

`devenv build outputs.web` and `devenv build outputs.sync-server` realize the
production artifacts. Keeping artifact construction separate from tasks makes
it reproducible and cacheable.

`devenv --profile browser test` adds pinned Chromium-based IndexedDB contract
and Web E2E suites. The separate profile prevents normal shell users from
paying the Playwright browser download and closure cost. CI builds both
deployable outputs, runs this full gate, and uploads the checkout-local
Playwright failure artifacts.

Workspace tests cover the synchronization protocol and native/WebSocket
convergence behavior. The database task starts an isolated temporary PostgreSQL
for migration, authorization, idempotency, fault, and restore verification;
workspace tests skip only that external-database case when `DATABASE_URL` is
absent.

The standard Rust, component, IndexedDB, and Web E2E suites cover Step 7's
protocol/client contracts, authorization revocation, multi-tab identity,
mocked remote Web UX, durable outbox, and headless convergence behavior. The
only separate Step 7 task starts isolated PostgreSQL and the sync server, mints
test-only credentials, and verifies a real two-profile
online/offline/reconnect/revocation journey.

## Commands

```text
devenv shell
devenv up
devenv up web
devenv up sync-server
devenv build outputs.web
devenv build outputs.sync-server
devenv tasks run web:test-components
devenv tasks run sync-server:test
devenv --profile browser tasks run test:e2e-collaboration
devenv test
devenv --profile browser shell
devenv --profile browser test
```
