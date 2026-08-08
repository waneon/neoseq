# Build and Verification Architecture

## Current Boundary

Nix is the supported entry point for development, builds, tests, and CI.
`flake.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin resolution. Current product
artifacts are the static Web client and its Rust/Wasm core; sync services, native
shells, signing, and release provenance enter in the stages that implement them.

## Source Boundaries

Derivations consume explicit source sets rather than the repository root:

- Cargo builds receive workspace manifests, Rust crates, contracts, and fixtures;
- Web builds receive frontend sources, manifests, generators, locale catalogs,
  contracts, and generated outputs;
- browser harnesses additionally receive Vitest and Playwright suites;
- generated drift checks receive only their source contract, generator, and outputs;
- dependency installation receives pnpm workspace manifests and the lockfile.

The pnpm dependency fetcher output name fingerprints its manifests and lockfile,
so dependency changes cannot reuse a stale fixed-output closure. Documentation
or unrelated platform-plan edits do not invalidate product source derivations.

## Flake Outputs

- `packages.web`: production static application;
- `packages.core-wasm` and `wasm-bindings`: optimized Rust/Wasm adapter artifacts;
- `packages.browser-harness`: test-mode Web build shared by browser suites;
- `apps.web-dev`: checkout-backed Vite development server;
- `apps.web-preview`: local server for the exact production package;
- focused Rust, component, IndexedDB, and Web E2E test apps;
- `devShells.default`: Rust, Node/pnpm, and Wasm build tools;
- `devShells.browser-test`: the default shell plus Playwright browsers.

The default Rust toolchain includes formatting, Clippy, and
`wasm32-unknown-unknown`. Server, Android, Tauri, signing, and release-only tools
are excluded until their delivery stages.

## Build Graph

```text
domain ──> query ──> graph-core ──> platform-web ──> Wasm bindings ──> Web
   │                      │
   └──────────────────────┴──> platform-native / SQLite verification

pnpm manifests ──> dependency closure ──> Web, component, browser consumers
```

Production Wasm uses a size-oriented profile with LTO, one codegen unit,
aborting panics, and stripped symbols. Development bindings use the normal
release profile for a faster feedback loop. Production delivery must serve
hashed assets with Brotli or gzip; `web-preview` exercises that behavior.

## Product and Test Modes

Normal Vite builds include product routes, the real wall clock, and ordinary
CorePort/adapter operations. Test mode additionally includes the storage contract
page, deterministic time, and injected persistence faults. The current CorePort
fixture is imported by that test-only chunk and is not copied to public assets.

Browser suites reuse one test harness. Component tests do not depend on Wasm or
a production bundle. Persistence tests select focused corpora so the complete
matrix is not repeated for each case.

## Checks and CI

`nix flake check` is the CI-equivalent gate. It covers:

- Rust formatting, strict Clippy, workspace tests, and dependency policy;
- product Wasm and Web builds;
- CorePort and locale generated-file drift;
- TypeScript and component tests;
- raw and gzip bundle budgets;
- on Linux, IndexedDB contract and critical Web E2E suites.

Darwin browser processes need host services unavailable in the Nix sandbox, so
developers run `test-indexeddb` and `test-e2e-web` explicitly there. CI retains
Playwright traces and error contexts for failed runs as short-lived artifacts.

## Developer Commands

```text
nix develop
nix develop .#browser-test
nix run .#web-dev
nix run .#web-preview
nix run .#test-client-components
nix run .#test-indexeddb
nix run .#test-e2e-web
nix run .#test-core-convergence
nix run .#test-query-conformance
nix flake check --print-build-logs
```

No sandboxed build downloads unpinned tools. Release metadata added later must
be emitted beside artifacts unless runtime behavior explicitly consumes it.
