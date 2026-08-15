# Build and Verification Architecture

## Boundary

devenv is the supported environment and command boundary for local development
and CI. `devenv.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin external
resolution. The current product artifacts are the static Web client and its
Rust/Wasm core; sync services, native shells, signing, and release provenance
enter only in the stages that implement them.

`devenv.nix` intentionally contains only developer-facing concerns:

- the stable Rust toolchain with formatting, Clippy, and the Wasm target;
- Node 22, pnpm 10, `wasm-bindgen`, and dependency-policy tooling;
- Web development and production-preview commands;
- the reproducible production Web output and verification task graph;
- an optional profile containing Playwright browsers and their environment.

`outputs.web` owns the deployable artifact. It builds from Git-tracked sources
inside the Nix sandbox with Cargo and pnpm dependencies fetched from their
lockfiles. Tasks own checks and ephemeral development or browser-test setup.
Package scripts do not define repository-wide build or verification flow.

## Build flow

```text
domain ──> query ──> graph-core ──> platform-web ──> Wasm bindings ──> Web
   │                      │
   └──────────────────────┴──> platform-native / SQLite verification
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

## Verification

`devenv test` runs the portable gate:

- Rust formatting, strict Clippy, workspace tests, and dependency policy;
- generated CorePort and locale drift checks;
- TypeScript and component tests.

`devenv build outputs.web` realizes the production Web/Wasm artifact. Keeping
artifact construction separate from tasks makes it reproducible and cacheable.

`devenv --profile browser test` adds pinned Chromium-based IndexedDB contract
and Web E2E suites. The separate profile prevents normal shell users from
paying the Playwright browser download and closure cost. CI builds `outputs.web`,
runs this full gate, and uploads the checkout-local Playwright failure artifacts.

## Commands

```text
devenv shell
devenv shell -- web-dev
devenv shell -- web-preview
devenv build outputs.web
devenv tasks run web:test-components
devenv test
devenv --profile browser shell
devenv --profile browser test
```
