# Build and Verification Architecture

## Boundary

devenv is the supported environment and command boundary for local development
and CI. `devenv.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin external
resolution. The current build targets are the static Web client, its Rust/Wasm
core, the dashboard, the Rust synchronization server, and their Linux
all-in-one OCI image. Native shells, signing, and release provenance enter only
in the stages that implement them.

The devenv configuration is composed around four developer-facing concerns:

- a shared Rust, Node, pnpm, PostgreSQL, and artifact foundation;
- one pinned repository formatter spanning maintained source, configuration,
  and documentation;
- one supervised development runtime; and
- one verification graph, extended by the optional browser profile.

The browser profile adds Playwright's browsers and PostgreSQL tools.
Database tests use the shared PostgreSQL service but own a temporary database
per suite.
Development processes use fixed declared ports; a conflict fails startup rather
than silently selecting another port. Browser verification instead picks free
ports per run and owns its servers, so concurrent runs never contend.

`outputs.neoseq-client`, `outputs.neoseq-server`, and
`outputs.neoseq-dashboard` own the deployable component artifacts.
`outputs.neoseq-docker` composes their release outputs
with pinned ingress, PostgreSQL, and init binaries as a reproducible Linux
image. All build from Git-tracked sources inside the Nix sandbox with
dependencies fetched from the lockfiles. Fixed-output dependency names include
their lockfile digest, so a lockfile change cannot reuse a previously validated
store path. Devenv does not serve those outputs; its processes own the
source-based development runtime, while tasks own checks and ephemeral database
or browser setup. Package scripts do not define repository-wide build or
verification flow.

## Build flow

```text
domain ──> query ──> graph-core ──> platform-web ──> Wasm bindings ──> Web
   │                      │
   └──────────────────────┴──> platform-native / SQLite verification

sync-protocol ──> neoseq-server ──> PostgreSQL / WebSocket verification

client + dashboard + server + appliance controller + runtime tools
  └──> neoseq-docker Linux OCI image
```

The `neoseq-client` output compiles `platform-web`, generates Wasm bindings, checks the
client, and installs the static site as one Nix store artifact. Production Wasm
uses the `wasm-release` profile with size optimization, LTO, one codegen unit,
aborting panics, and stripped symbols. Development and browser test builds use
the regular release profile for a faster loop.

The `neoseq-dashboard` output checks the independent account administration app
and installs its static site as a separate Nix store artifact.

One generator turns `contracts/` into the Rust and TypeScript sources that must
agree: the CorePort DTOs and error codes, the graph document-schema version, and
the sync protocol version with its WebSocket subprotocol name. The drift check
runs before every other check, so a version bumped in only one language fails
the build instead of the running system. Domain payloads and sync message shapes
are exported from their Rust serde declarations with build-only TypeScript
derives. The same drift check verifies those bindings; the Web client does not
maintain parallel payload declarations.

Normal Vite builds contain product routes and real adapters. Test mode adds the
storage contract page, deterministic time, and injected persistence faults.
Development and test-mode bindings remain checkout-local ignored artifacts;
the production artifact exists only as a Nix output.

The `neoseq-server` output builds the release service and appliance lifecycle
controller together and installs both binaries in one Nix store artifact.
Forward-only PostgreSQL migrations are embedded in the service and run
transactionally before readiness. On Linux, the all-in-one output combines this
artifact with the two static sites, Caddy, `tini`, PostgreSQL 17, and the minimal
runtime closure; build tools are not copied into the image.
For local development, the supervised sync server waits for the persistent
PostgreSQL service and exposes an HTTP readiness probe. Database-backed tests
share the devenv-managed PostgreSQL service while each suite owns a uniquely
named database.

## Verification

Verification is split into tiers. Each is a devenv task that runs alone
(`devenv tasks run gate:<tier>`) and as its own CI job, so a failure names its
tier and no tier's timing depends on another tier's compilation load:

- `gate:check`: formatting, generated contract and locale drift, TypeScript
  (including browser test sources), strict Clippy, dependency policy, Node
  licenses, and fixed-output dependency hashes;
- `gate:rust`: Rust workspace and PostgreSQL integration tests;
- `gate:component`: client and dashboard component tests;
- `gate:browser` (browser profile): Playwright journeys and browser contracts.

`devenv test` runs the first three; `devenv --profile browser test` runs all
four.

The component-test task depends on the development Wasm binding because its
CorePort adapter runs the production graph core rather than a TypeScript domain
double. The bindgen CLI is pinned to the `wasm-bindgen` version in `Cargo.lock`,
for both the development binding and the production output, because the two
must match exactly.

Treefmt is the single formatting boundary. It delegates Rust, Nix, Web and
document formats, TOML, and shell scripts to pinned language-native formatters.
Generated sources remain owned by their generators, and lockfiles remain owned
by their package managers. Running
`treefmt` formats maintained files; the portable gate runs the same formatter
set in CI mode and rejects drift.

`devenv build outputs.neoseq-client`, `devenv build outputs.neoseq-server`,
`devenv build outputs.neoseq-dashboard`, and
`devenv -s <linux-system> build outputs.neoseq-docker` realize the production
artifacts. Keeping artifact construction separate from tasks makes it
reproducible and cacheable. Commit verification and image publication have separate
workflows: branch pushes and pull requests run the portable gate, while version
tag pushes build and publish the all-in-one image without repeating that gate.
The standalone container smoke test verifies both public
applications, readiness, bounded stop, logical backup, offline restore, and
restart against the same persistent volume, so filesystem layers and OCI
metadata cannot drift unexecuted. It also verifies the default and custom
application identities, ownership migration, and initialization of a fresh
cluster with custom ownership.

The `publish-docker` devenv script realizes that same image for `x86_64-linux`
and publishes it to `waneon/neoseq`. Its version is owned by the Cargo workspace
and carried by the artifact's OCI label. The script verifies the loaded platform
and publishes one image ID under its version before advancing `latest`.
Publication is an explicit developer command or a stable `vMAJOR.MINOR.PATCH`
tag push. The release workflow requires the tag to match the Cargo workspace
and both Web app versions before registry login or publication. Other tags and
ordinary branch or pull-request checks cannot publish. Tag runs share a
concurrency group so publications do not overlap. Docker Hub credentials belong
to GitHub Actions configuration, never the repository or Nix build inputs.

The browser profile supplies Playwright's browsers, fonts, and PostgreSQL tools;
it does not orchestrate the run. Playwright builds and serves the product and
test-mode artifacts and runs a collaboration server on a throwaway database, on
ports chosen per run. The [browser verification architecture](browser-testing.md)
defines the coverage boundaries, isolation, and evidence expected from each
suite. In CI the browser tier is advisory until its runs on Linux runners are
reliably green.

## Asynchronous verification

Tests synchronize on observable state, not elapsed wall-clock time. Local
machines and CI runners differ in scheduling, CPU contention, and rendering
latency, so whether a test passes must not depend on how fast the machine is.

The application owns the answer to "has the reader's work settled?". It counts
outstanding work in one place — unsaved editor input, debounced saves, and graph
work queued or running in the core — and publishes `data-busy` on the document
while any remains. Work is registered synchronously by the code that starts it.
Browser journeys act, wait for the application to settle, and assert visible
outcomes with retrying assertions; they do not encode which gesture saves or
when. Where a test could only pass by waiting for something the reader cannot
see, the application is fixed instead: input survives reconciliation, and
controls stay stable under the pointer.

Component tests run the real graph core with real timers. Their fixtures settle
the work an interaction starts inside that interaction's `act()` scope. React
diagnostics that the test code alone determines — overlapping or unawaited
`act()` scopes — fail the suite. Diagnostics whose appearance depends on
scheduling (an update settling just outside a scope) are reported but do not
fail, because as failures they passed on workstations and failed on CI runners
without any change in behavior. Time-dependent product behavior uses controlled
clocks. Browser retries are disabled. Suite timeouts remain failure budgets
only; arbitrary sleeps must not order test actions.

Workspace tests cover the synchronization protocol and native/WebSocket
convergence behavior. The database task depends on PostgreSQL readiness and
runs the explicitly ignored schema, authorization, idempotency, and fault
integration test against its own database.

Rust and browser adapter contracts cover synchronization, authorization,
multi-tab identity, the durable outbox, and convergence. Component tests use
controlled remote responses to exercise individual client states. Product
browser journeys use the real service for account sessions, repository catalogs,
archive import, deletion, offline recovery, and independent-replica convergence
and revocation.
