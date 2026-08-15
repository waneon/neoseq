# Development

devenv provides the Rust, Node, pnpm, Wasm, and verification tools used by CI.
Entering the shell also installs the locked pnpm workspace dependencies when
the lockfile changes.

```sh
devenv shell                         # normal Rust and Web work
devenv shell -- web-dev              # Vite on 127.0.0.1:4173
devenv shell -- web-preview          # production output on 127.0.0.1:4174
devenv --profile browser shell       # add pinned Playwright browsers
```

## Before changing code

- Read [ARCHITECTURE.md](ARCHITECTURE.md) and the relevant document under
  [`architectures/`](architectures/). Update them when a boundary or contract
  changes.
- For frontend work, treat [DESIGN.md](DESIGN.md) as the UI/UX contract.
- Inspect the working tree and diff to understand and preserve existing work.
- Keep generated CorePort files in sync by changing
  [`contracts/core-port.json`](contracts/core-port.json) and running
  `devenv tasks run coreport:generate`; do not edit generated outputs by hand.
- Keep locale catalogs in sync by editing the manifest and JSON files under
  `apps/client/src/i18n/locales`, then running
  `devenv tasks run i18n:generate`; do not edit generated message types by
  hand.

## Build and test

Use the smallest test that can catch the behavior while iterating, then broaden
validation for the affected boundary. Rust tests own domain, core, persistence,
and query semantics; Vitest owns isolated UI behavior; Playwright is reserved
for browser boundaries and critical user journeys.

Focused Rust examples:

```sh
cargo test -p domain property
cargo test -p graph-core model_
cargo test -p graph-core convergence_ -- --nocapture
cargo test -p query sparql_
cargo test -p platform-native core_port
cargo test -p platform-web
```

Focused frontend examples:

```sh
pnpm --filter @neoseq/client exec vitest run tests/component/outline.test.tsx
devenv tasks run web:test-components
devenv tasks run web:check
devenv build outputs.web
```

For Playwright work, build the test-mode client once before running focused
cases in the browser profile:

```sh
devenv --profile browser tasks run web:build-test
devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test tests/persistence.spec.ts --project=chromium --grep "Worker adapter"
devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test e2e/ --project=chromium --grep "survives reload"
```

Build the deployable output separately from the verification tasks. The
complete non-browser gate and CI-equivalent gate are:

```sh
devenv build outputs.web
devenv test
devenv --profile browser test
```

The browser profile is separate so normal development does not download the
Playwright browser closure. The output is a sandboxed, lockfile-backed Web/Wasm
artifact. The verification tasks check Rust formatting, Clippy, workspace
tests, dependency policy, generated files, TypeScript, component tests,
IndexedDB contracts, and Web E2E journeys.

### Checks by change risk

| Change | Required before handoff |
| --- | --- |
| Documentation only | Review links, commands, and the final diff; product tests are unnecessary. |
| Rust behavior | Focused test, owning crate tests, and relevant Clippy; use `devenv test` for broad changes. |
| React or TypeScript behavior | Focused component test, `web:test-components`, and `web:check`. |
| Styling, accessibility, keyboard, routing, or responsive behavior | Relevant component test plus focused E2E across affected Playwright projects. |
| CorePort, generated schema, Worker, IndexedDB, or persistence | Relevant Rust tests, generated-file check, and focused IndexedDB tests; add E2E when a user journey changes. |
| Dependencies, devenv, build inputs, or production output | `devenv build outputs.web` and `devenv test`; add the browser profile when browser behavior or dependencies are affected. |
| Cross-cutting or merge-ready change | `devenv build outputs.web` and `devenv --profile browser test` after focused suites pass. |

## Repository map

- `crates/domain`: IDs, commands, properties, and domain invariants.
- `crates/graph-core`: CRDT runtime, transactions, events, and projections.
- `crates/query`: RDF index and constrained SPARQL execution.
- `crates/platform-*`: native/SQLite and WebAssembly adapters.
- `apps/client`: React UI, i18n catalogs/runtime, Web Worker, IndexedDB adapter,
  and browser tests.
- `contracts`: current generated-code and property-registry boundaries.
- `fixtures`: current cross-adapter contract corpus.

Keep changes within these boundaries and prefer the smallest architecture that
meets the current requirement.
