# Build, Delivery, and Verification Architecture

## Reproducibility Boundary

The repository uses a Nix flake as the supported entry point for development,
checks, and CI. `flake.lock`, `Cargo.lock`, and `pnpm-lock.yaml` pin the Nix
inputs, Rust dependencies, and frontend dependencies respectively. Builds do not
depend on developer shell profiles or globally installed package managers.

Nix reproducibility does not include secrets, Apple code-signing/notarization
services, Google Play signing, physical devices, or Apple's redistributability-
restricted Xcode/macOS SDK. Those are declared host inputs and pinned by CI
image and documented version.

## Flake Outputs

The Step 1 flake exposes:

- `devShells.default`: Rust, Node/pnpm, Wasm, database/client, formatting, and
  test tools for core and web work;
- `devShells.android` with the JDK, Android SDK/NDK, Gradle, and Rust Android
  targets;
- packages for the native core, Wasm core/bindings, web static application,
  sync spike server, unsigned macOS bundle, and Android debug APK;
- apps for cross-runtime parity, persistence/reload, and reordered/duplicated
  WebSocket synchronization spikes;
- a Darwin-only Android emulator smoke app that installs and starts the APK;
- checks for Rust formatting, strict Clippy, tests, dependency policy,
  generated-contract drift, web builds, and browser persistence.

Rust targets and components are pinned together. The Android shell supplies the
JDK, Android command-line tools/SDK/NDK and explicit accepted license
configuration. The macOS host check records the selected Xcode Command Line
Tools, macOS SDK, and Clang and fails with a clear diagnostic when they are
unavailable.

## Workspace Build Graph

```text
domain ───────────────┐
query ────────────────┼─> graph-core ─┬─> platform-web -> Wasm -> web app
sync-protocol ────────┘               └─> platform-native -> Tauri macOS/Android
sync-protocol ───────────────────────────> sync-server -> server image
```

Feature flags keep platform dependencies out of pure crates. Domain and query
code must build and test for native targets and `wasm32-unknown-unknown`.
Generated TypeScript contracts are build outputs checked for drift, not manually
edited parallel definitions.

## Developer Workflow

The canonical commands are exposed through flake apps or a small task runner
inside the Nix shell:

```text
nix develop
nix flake check
nix build .#web
nix build .#sync-server
```

Platform package tasks wrap Tauri commands while still consuming pinned
workspace artifacts. Later server steps will add the PostgreSQL integration
stack and migrations.

No build script downloads unpinned tools at execution time. Cargo and pnpm
network resolution is separated from sandboxed builds and represented by lock
files/hashes.

## CI Stages

1. **Fast checks:** formatting, Rust/TypeScript lint, unit tests, schema/codegen
   drift, architecture validation.
2. **Cross-runtime:** native and Wasm domain/query conformance plus browser
   worker tests.
3. **Integration:** PostgreSQL server tests and multi-client
   synchronization/fault scenarios.
4. **Platform smoke:** web production build, macOS unsigned bundle, Android
   debug APK on matching platform runners.
5. **Release:** signed/notarized macOS artifact, signed Android AAB, immutable
   web assets, and server image/SBOM/provenance.

Pure checks run on Linux where possible. macOS and Android packaging use
dedicated runners because successful Nix evaluation is not proof that platform
SDK packaging works.

## Quality Gates

- `cargo fmt`, strict Clippy policy, Rust tests, and public API documentation
  checks;
- frontend formatting, lint, typecheck, component tests, and bundle-size budget;
- native/Wasm DTO and query golden parity;
- randomized Loro convergence and persistence recovery tests;
- server protocol, database migration, authorization, and load/backpressure
  tests;
- dependency license/advisory review, secret scan, SBOM, and pinned-source
  checks;
- rendered architecture link validation and the required sub-300-line limit for
  each architecture document.

Changes to a CRDT schema, well-known property definition, query-language
version, `CorePort`, archive, or sync wire protocol require compatibility
fixtures in the same change.

## Configuration and Secrets

Compile-time configuration is limited to public product metadata and protocol
ranges. Server runtime configuration uses validated environment/file input;
deployment secrets come from the platform secret store. Client credentials use
OS secure storage on native platforms and secure, server-managed web sessions in
the browser. `.env` files are development conveniences and are neither required
nor committed.

## Release Compatibility

Artifacts embed application version, source revision, CRDT schema range,
CorePort version, sync protocol range, query-language version, and build target.
The server advertises minimum/supported client and schema ranges before
accepting updates.

Rollout order for a compatible change is server first, then clients. A breaking
schema migration requires an explicit write gate and minimum-client rollout; an
old client may export/read supported state but cannot write an incompatible
graph.

## Initial Technical Spikes

Before feature implementation, CI proves the riskiest boundaries with disposable
vertical slices:

1. compile the pinned Rust Loro stack inside both native and Wasm graph-core
   builds;
2. edit and persist one graph in SQLite and IndexedDB, restart, and compare
   state;
3. synchronize two native/Wasm peers through the server with offline divergence;
4. package the same UI/core as a macOS app and Android debug APK;
5. exchange divergent updates between native and Wasm peers while a relay
   duplicates and reorders frames, then compare semantic state hashes.

Failure of a spike changes the relevant adapter, not the domain or `CorePort`
boundary. Tauri prerequisites and platform packaging follow the official
[Tauri prerequisite](https://v2.tauri.app/start/prerequisites/) and
[distribution](https://v2.tauri.app/distribute/) guidance.
