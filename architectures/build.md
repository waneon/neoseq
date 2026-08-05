# Build, Delivery, and Verification Architecture

## Current Boundary

Nix is the supported entry point for development, checks, and CI. `flake.lock`,
`Cargo.lock`, and `pnpm-lock.yaml` pin tool and dependency resolution. Step 5
ships only the static Web application and its Rust/Wasm core. Native shells,
sync services, mobile SDKs, signing, and release provenance are introduced by
the steps that actually use them.

## Source Boundaries

Derivations consume explicit source sets instead of the repository root:

- Cargo builds receive workspace manifests, crates, and core fixtures;
- production Web builds receive frontend sources, manifests, generators, and
  runtime property definitions, including locale catalogs and generated types;
- browser harnesses additionally receive Playwright/Vitest tests and golden
  CorePort fixtures;
- generated-contract drift receives only its schema, generator, and outputs;
- dependency installation receives only pnpm workspace manifests and lockfile.

The pnpm dependency fetcher's output name includes a fingerprint of those
manifests and the lockfile. Any dependency-input change therefore creates a new
fixed-output path and validates the declared dependency hash, even when an older
dependency closure remains in the local Nix store. The fetched closure is
platform-independent and uses one hash across supported systems.

Consequently an edit to `flake.nix`, documentation, native plans, or historical
verification does not invalidate Cargo, Wasm, pnpm dependency, or Web source
derivations. Nix still evaluates the changed flake and may recreate a tiny app
wrapper when its value changes; it does not rebuild unrelated product inputs.

Source revision and toolchain manifests are release provenance, not runtime
inputs. They are deliberately absent at Step 5 so a metadata-only change cannot
rebuild Wasm and every downstream Web artifact.

The Web diagnostic recorder consumes the application version and
`NEOSEQ_BUILD_ID` injected by Vite without linking VCS metadata into Wasm.
Development builds use an explicit `development` identity. Independent Web and
core asset hashes remain a release-provenance extension; adding them must not
invalidate the core or dependency derivations.

## Flake Outputs

- `packages.web`: the production static application;
- `packages.core-wasm` and `wasm-bindings`: size-optimized product Rust/Wasm
  adapter artifacts;
- `packages.core-tools`: YAML scenario runner built with the Rust
  `test-support` feature;
- `packages.browser-harness`: one test-mode Web build reused by browser suites;
- `apps.web-dev`: checkout-backed Vite server with Nix dependencies and
  development Wasm plus a writable checkout-local optimizer cache;
- `apps.web-preview`: serves the exact production package with negotiated
  response compression on port 4174;
- focused Rust, IndexedDB, component, and Web E2E test apps;
- `devShells.default`: Rust, Node/pnpm, Wasm binding, and core build tools;
- `devShells.browser-test`: the default shell plus Playwright browsers.

The Rust toolchain is the minimal profile with formatting, Clippy, and the
`wasm32-unknown-unknown` target. Android targets, JDK, Gradle, Tauri, PostgreSQL,
and release-only tools are not part of the normal development closure.

## Build Graph

```text
domain ──> query ──> graph-core ──> platform-web ──> Wasm bindings ──> Web
   │                      │                 └──────> development Web/tests
   └──────────────────────┴──> platform-native (headless SQLite tests)
pnpm manifests ──> dependency closure ──> Web/component/browser consumers
```

The production Web bundle is built once. Browser persistence and product E2E
checks copy and run the same test-mode harness instead of rebuilding Vite.
Component tests reuse a dependency/source harness and do not depend on Wasm or
a production build.

Production Wasm uses the `wasm-release` Cargo profile with size optimization,
fat LTO, one codegen unit, aborting panics, and stripped symbols. Development
and browser-test bindings retain the ordinary release profile so editing the
core does not add fat-LTO latency to the normal feedback loop. The production
delivery boundary must negotiate Brotli or gzip for hashed static assets;
`web-preview` exercises that behavior locally.

## Product and Verification Modes

Normal `vite build` emits only user routes, the real wall clock, and ordinary
CorePort/adapter operations. `vite build --mode test` additionally enables the
storage contract route, deterministic clock, and fault controls. The golden
CorePort transcript is imported by this test-only chunk rather than copied to
public assets.

Playwright persistence tests select one corpus each, so persistence, Worker
contract, and recovery cases do not rerun the full matrix in every test.

## Checks and CI

`nix flake check` is the single Step 5 CI command. It covers:

- Rust formatting, strict Clippy, workspace tests, and dependency policy;
- product Wasm and Web builds;
- generated CorePort drift;
- typed locale-catalog compilation and generated locale/message-type drift;
- frontend component tests and raw plus gzip bundle budgets, including a separate
  raw budget for the self-hosted font asset;
- on Linux, the focused IndexedDB contract and Web E2E suites.

Darwin browser processes require host services unavailable in the Nix build
sandbox, so browser apps run those same prebuilt harnesses on the host. CI does
not repeat explicit builds already contained in the check graph, and does not
build macOS/Android/sync spikes before their implementation steps.
On failure, CI preserves the failed Nix build directory long enough to upload
Playwright traces and error contexts as a short-lived diagnostic artifact.

## Developer Workflow

```text
nix develop
nix develop .#browser-test
nix run .#web-dev
nix run .#web-preview
nix flake check
nix run .#test-indexeddb
nix run .#test-client-components
nix run .#test-e2e-web
nix run .#test-query-projection
nix run .#test-query-rebuild
nix run .#test-query-conformance
nix run .#test-query-differential
nix run .#test-query-budget
```

No build script downloads unpinned tools during a sandboxed build. Production
metadata added in the release step must be emitted beside artifacts, not linked
into the Wasm runtime unless product behavior consumes it.
