# Neoseq

Neoseq is a local-first outliner inspired by Logseq. It aims to be lightweight,
fast, and bug-free.

## Quick start

Neoseq uses `devenv` to manage its development environment. With `devenv`, you
can start the Web client, PostgreSQL, and synchronization server with a single
command:

```sh
devenv --profile release-serve up
```

This serves the Neoseq app at `http://127.0.0.1:4174`.

## Development

Enter the development shell with the following command. This also installs the
locked pnpm workspace dependencies whenever the lockfile changes.

```sh
devenv shell
```

Start the development Web client with Hot Module Replacement (HMR), then open
`http://127.0.0.1:4173`. Frontend changes are applied automatically. After
changing Rust code, rebuild the development Wasm bindings to trigger HMR.

```sh
# Start the development services and HMR-enabled Web client.
devenv up

# In another development shell, rebuild Wasm after changing Rust code.
devenv tasks run wasm:build-dev
```

Build the reproducible production artifacts independently for the static Web
application and the Rust synchronization service.

```sh
devenv build outputs.web          # Rust/Wasm core and static Web client
devenv build outputs.sync-server  # PostgreSQL-backed sync server binary
```

Run the portable verification gate by default. The `browser-test` profile adds
pinned Chromium, IndexedDB contracts, and end-to-end scenarios.

```sh
devenv test                         # Rust, generated files, TypeScript, and components
devenv --profile browser-test test  # portable gate plus browser-backed tests
```

## Performance benchmarks

The dedicated benchmark workspace member has deterministic Criterion suites for
index construction and refreshes, and representative shapes over 100,
10,000, and 1,000,000 blocks.

```sh
# Run both benchmark suites.
cargo bench -p neoseq-benchmarks
```

## Sync server

Start the local PostgreSQL service and sync server together. In another devenv
shell, create a graph, grant membership, and issue development-only tokens.

```sh
export DATABASE_URL="postgresql:///neoseq?host=$PGHOST"
export NEOSEQ_TEST_AUTH_SECRET=neoseq-local-development-only
cargo run -p sync-server -- create-graph demo-graph alice
cargo run -p sync-server -- grant demo-graph bob editor
cargo run -p sync-server -- issue-token alice
```
