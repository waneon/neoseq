# Development

devenv provides the Rust, Node, pnpm, Wasm, and verification tools used by CI.
Entering the shell also installs the locked pnpm workspace dependencies when
the lockfile changes.

```sh
devenv shell                         # normal Rust and Web work
devenv up                            # Web, PostgreSQL, and sync server
devenv up web                        # Vite on 127.0.0.1:4173
devenv up sync-server                # PostgreSQL and sync server on 127.0.0.1:8787
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
cargo test -p sync-protocol
cargo test -p sync-server --test sync_faults
```

Focused frontend examples:

```sh
pnpm --filter @neoseq/client exec vitest run tests/component/outline.test.tsx
devenv tasks run frontend:test
devenv tasks run frontend:check
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
devenv build outputs.sync-server
devenv test
devenv --profile browser test
```

The workspace Rust test task covers the synchronization protocol and in-memory
server tests. The PostgreSQL integration test is explicitly ignored there and
owned by `sync-server:test`. Devenv starts the managed PostgreSQL service, while
the task creates and removes a uniquely named database for the suite:

```sh
devenv tasks run rust:test
devenv tasks run sync-server:test
```

`devenv up sync-server` starts the persistent local PostgreSQL service and the
server, applying embedded migrations on connection. In another devenv shell,
the admin commands can create graphs, manage membership, and mint local test
tokens. Production identity remains an adapter boundary.

```sh
export DATABASE_URL="postgresql:///neoseq?host=$PGHOST"
export NEOSEQ_TEST_AUTH_SECRET=neoseq-local-development-only
cargo run -p sync-server -- create-graph demo-graph alice
cargo run -p sync-server -- grant demo-graph bob editor
cargo run -p sync-server -- issue-token alice
```

For the Web remote-beta demo, run `devenv up`, then mint one token per browser
profile in another shell:

```sh
export NEOSEQ_TEST_AUTH_SECRET=neoseq-local-development-only
export ALICE_TOKEN="$(cargo run -p sync-server -- issue-token alice)"
export BOB_TOKEN="$(cargo run -p sync-server -- issue-token bob)"
```

Open `http://127.0.0.1:4173` in two independent browser profiles. In the first,
choose **Remote**, leave the server URL at the Web origin, enter `alice` and
`ALICE_TOKEN`, create the graph, then use **Manage members** to invite `bob` as
an editor. In the second, choose **Remote**, enter `bob` and `BOB_TOKEN`, and
select **Connect available graphs**. Browser credentials live only for that tab
session; the Vite `/v1` proxy connects both HTTP and WebSocket traffic to the
local sync server.

The complete browser-profile gate covers the sync contracts, authorization
boundaries, multi-tab identity, mocked remote UX, durable browser outbox, and a
real two-browser scenario. For that final scenario, devenv starts a test-only
sync-server process on an allocated port and gives it a uniquely named
PostgreSQL database and test credentials:

```sh
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
| React or TypeScript behavior | Focused component test, `frontend:test`, and `frontend:check`. |
| Styling, accessibility, keyboard, routing, or responsive behavior | Relevant component test plus focused E2E across affected Playwright projects. |
| CorePort, generated schema, Worker, IndexedDB, or persistence | Relevant Rust tests, generated-file check, and focused IndexedDB tests; add E2E when a user journey changes. |
| Dependencies, devenv, build inputs, or production output | Build the affected output and run `devenv test`; add the browser profile when browser behavior or dependencies are affected. |
| Cross-cutting or merge-ready change | Build `outputs.web` and `outputs.sync-server`, then run `devenv --profile browser test` after focused suites pass. |

## Repository map

- `crates/domain`: IDs, commands, properties, and domain invariants.
- `crates/graph-core`: CRDT runtime, transactions, events, and projections.
- `crates/query`: RDF index and constrained SPARQL execution.
- `crates/platform-*`: native/SQLite and WebAssembly adapters.
- `crates/sync-protocol`: versioned, size-bounded binary sync messages.
- `crates/sync-server`: durable PostgreSQL/WebSocket sync service.
- `apps/client`: React UI, i18n catalogs/runtime, Web Worker, IndexedDB adapter,
  and browser tests.
- `contracts`: current generated-code and property-registry boundaries.
- `fixtures`: current cross-adapter contract corpus.

Keep changes within these boundaries and prefer the smallest architecture that
meets the current requirement.
