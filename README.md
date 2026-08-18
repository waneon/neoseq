# Neoseq

Neoseq is a local-first outliner for journals, Markdown blocks, typed
properties, tasks, and graph search. Its Rust core runs in a Web Worker and
stores graphs in IndexedDB.

Queries live in the outline. Typing `/` builds one visually — conditions,
grouping, columns, sorting — and it compiles to the read-only SPARQL the core
runs, which stays visible and editable for anyone who prefers to write it.

## Quick start

Start the Web client, PostgreSQL, and synchronization server, then open
`http://127.0.0.1:4173`.

```sh
devenv up
```

## Development

devenv provides the Rust, Node, pnpm, Wasm, and verification tools used by CI.
Entering the shell also installs the locked pnpm workspace dependencies when
the lockfile changes.

```sh
devenv shell                         # normal Rust and Web work
devenv --profile browser-test shell  # add pinned Playwright browsers
```

## Build and test

Build the reproducible production artifacts independently for the static Web
application and the Rust synchronization service.

```sh
devenv build outputs.web          # Rust/Wasm core and static Web client
devenv build outputs.sync-server  # PostgreSQL-backed sync server binary
```

Serve both release artifacts with the managed PostgreSQL service.

```sh
devenv --profile release-serve up
```

Run the portable verification gate by default. The `browser-test` profile adds
pinned Chromium, IndexedDB contracts, and end-to-end scenarios.

```sh
devenv test                         # Rust, generated files, TypeScript, and components
devenv --profile browser-test test  # portable gate plus browser-backed tests
```

## Sync server

Start the local PostgreSQL service and sync server together. In another devenv
shell, create a graph, grant membership, and issue development-only tokens.

```sh
devenv up sync-server  # PostgreSQL and sync server on 127.0.0.1:8787
```

```sh
export DATABASE_URL="postgresql:///neoseq?host=$PGHOST"
export NEOSEQ_TEST_AUTH_SECRET=neoseq-local-development-only
cargo run -p sync-server -- create-graph demo-graph alice
cargo run -p sync-server -- grant demo-graph bob editor
cargo run -p sync-server -- issue-token alice
```
