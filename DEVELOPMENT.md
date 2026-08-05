# Development

Nix is the supported tool entry point. It provides the pinned Rust, Node,
pnpm, Wasm, and browser toolchains used by CI.

```sh
nix develop                    # normal Rust and Web work
nix develop .#browser-test     # work that needs Playwright browsers
nix run .#web-dev              # Vite development server on 127.0.0.1:4173
nix run .#web-preview          # production bundle on 127.0.0.1:4174
```

For a fast frontend loop, install the locked dependencies once from
`nix develop` with `pnpm install --frozen-lockfile`. The `nix run` test apps do
not require a checkout-local installation.

## Before changing code

- Read [ARCHITECTURE.md](ARCHITECTURE.md) and the relevant document under
  [`architectures/`](architectures/). Update them when a boundary or contract
  changes.
- For frontend work, treat [DESIGN.md](DESIGN.md) as the UI/UX contract.
- Inspect the working tree and diff to understand and preserve existing work.
- Keep generated CorePort files in sync by changing
  [`contracts/core-port.json`](contracts/core-port.json) and running
  `node scripts/generate-contracts.mjs`; do not edit generated outputs by hand.

## Testing workflow

Use the smallest test that can catch the defect during the edit loop, then
broaden validation once the change is stable:

1. Identify the changed behavior and the lowest layer that owns it.
2. Add or update a regression test at that layer.
3. Run the exact test while iterating. After a failure, rerun only the failed
   target until it passes.
4. Run the owning package or feature suite, then the checks required by the
   change-risk table below.
5. Before handoff, review the final diff and report the commands run, their
   results, and any checks intentionally omitted.

Do not duplicate the same assertion at every layer. Rust tests own domain,
core, persistence, and query semantics; Vitest owns isolated UI behavior;
Playwright is reserved for browser boundaries and critical user journeys.
Never remove, skip, or weaken a test merely to make a change pass.

### Focused commands

Rust test apps accept Cargo test filters where the app is not already scoped to
a named suite:

```sh
nix run .#test-domain -- property
nix run .#test-core-model
nix run .#test-core-convergence
nix run .#test-query-projection
nix run .#test-query-rebuild
nix run .#test-query-conformance
nix run .#test-query-differential
nix run .#test-query-budget
```

For another crate or a single Rust test, run Cargo in the development shell:

```sh
cargo test -p platform-native core_port
cargo test -p platform-web
```

Run one component file during UI iteration, then the complete component suite:

```sh
pnpm --filter @neoseq/client exec vitest run tests/component/outline.test.tsx
nix run .#test-client-components
```

Use `--grep` to narrow browser tests by test title. Include mobile or dark-mode
projects only when the behavior applies to them.

```sh
nix run .#test-indexeddb -- --grep "Worker adapter"
nix run .#test-e2e-web -- --project chromium --grep "survives reload"
```

Useful broader checks are:

```sh
cargo fmt --all -- --check                # Rust formatting
cargo clippy -p graph-core --all-targets --all-features -- --deny warnings
pnpm check                              # TypeScript
bash scripts/check-generated.sh         # generated CorePort drift
nix build .#web                         # production Web/Wasm build
nix flake check --print-build-logs      # complete CI gate
```

### Checks by change risk

| Change | Required before handoff |
| --- | --- |
| Documentation only | Review the rendered links, commands, and final diff; product tests are unnecessary. |
| Rust behavior | Focused test, owning crate/suite, and relevant Clippy or `nix flake check` for broad changes. |
| React or TypeScript behavior | Focused component test, full component suite, and `pnpm check`. |
| Styling, accessibility, keyboard, routing, or responsive behavior | Relevant component test plus focused E2E; exercise every affected Playwright project. |
| CorePort, generated schema, Worker, IndexedDB, or persistence | Relevant Rust tests, generated-file check, and `test-indexeddb`; add focused E2E when a user journey changes. |
| Dependencies, Nix, build inputs, or production output | `nix flake check`; use `nix build .#web` during iteration. |
| Cross-cutting or merge-ready change | `nix flake check` once after focused suites pass. |

On Linux, `nix flake check` includes IndexedDB and Web E2E tests. On Darwin,
browser processes cannot run in the Nix sandbox, so run the relevant
`test-indexeddb` and `test-e2e-web` apps explicitly in addition to the flake
check.

## Repository map

- `crates/domain`: IDs, commands, properties, and domain invariants.
- `crates/graph-core`: CRDT runtime, transactions, events, and projections.
- `crates/query`: RDF index and constrained SPARQL execution.
- `crates/platform-*`: native/SQLite and WebAssembly adapters.
- `apps/client`: React UI, Web Worker, IndexedDB adapter, and browser tests.
- `contracts` and `fixtures`: versioned boundaries and compatibility data.

Keep changes within these boundaries and prefer the smallest architecture that
meets the current requirement. Use `nix flake check` as the final CI-equivalent
gate, not as the inner edit loop.
