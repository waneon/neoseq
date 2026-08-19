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
- optional profiles for Playwright verification and serving release artifacts.

`outputs.web` and `outputs.sync-server` own the deployable artifacts. They build
from Git-tracked sources inside the Nix sandbox with dependencies fetched from
the lockfiles. The `release-serve` profile runs those artifacts behind one Web
origin with a profile-local managed PostgreSQL instance. Its process ports and
persistent state are isolated from the base development runtime, so both
environments can run concurrently. Base processes and services own the
development runtime; tasks own checks and ephemeral database or browser-test
setup. Package scripts do not define repository-wide build or verification flow.

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
PostgreSQL service and exposes an HTTP readiness probe. Database-backed tests
share the devenv-managed PostgreSQL service while each suite owns a uniquely
named database.

## Verification

`devenv test` runs the portable gate:

- Rust formatting, strict Clippy, workspace and PostgreSQL integration tests,
  and dependency policy;
- generated CorePort and locale drift checks;
- TypeScript and component tests.

`devenv build outputs.web` and `devenv build outputs.sync-server` realize the
production artifacts. Keeping artifact construction separate from tasks makes
it reproducible and cacheable.

`devenv --profile browser-test test` adds pinned Chromium-based IndexedDB contracts,
parallel desktop E2E, focused mobile and dark-mode coverage, and a real
two-profile collaboration scenario. The scenario uses a test-only sync-server
process with an allocated port and an isolated database on the managed
PostgreSQL service. The separate profile prevents normal shell users from
paying the browser and service-orchestration cost. CI builds the deployable Web
output, runs this full gate, and uploads the checkout-local Playwright failure
artifacts.

Workspace tests cover the synchronization protocol and native/WebSocket
convergence behavior. The database task depends on PostgreSQL readiness and
runs the explicitly ignored migration, authorization, idempotency, fault, and
restore integration test against its own database.
Portable checks attach directly to the test lifecycle; process-backed suites
attach to the managed process graph so their dependencies start only once.

The Rust, component, IndexedDB, and Web E2E suites cover the remote
collaboration protocol/client contracts, authorization revocation, multi-tab
identity, mocked remote Web UX, durable outbox, and headless convergence
behavior. The collaboration stage additionally verifies a real two-profile
online/offline/reconnect/revocation journey through the assembled system.
