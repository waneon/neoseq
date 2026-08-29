# Neoseq

Neoseq is a local-first outliner inspired by Logseq. It aims to be lightweight,
fast, and bug-free.

## Quick start

Neoseq uses `devenv` to manage its development environment. With `devenv`, you
can start the Web client, PostgreSQL, and synchronization server with a single
command:

```sh
devenv up
```

This serves the development app at an allocated port starting from
`http://127.0.0.1:4173`.

## Development

Enter the development shell with the following command. This also installs the
locked pnpm workspace dependencies whenever the lockfile changes.

```sh
devenv shell
```

Format all maintained source, configuration, and documentation files with the
Nix-pinned repository formatter:

```sh
treefmt
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
applications and the Rust synchronization service.

```sh
devenv build outputs.web          # Rust/Wasm core and static Web client
devenv build outputs.admin        # Static sync-server Admin Web app
devenv build outputs.sync-server  # PostgreSQL-backed sync server binary
```

Run the portable verification gate directly. The `browser` profile adds pinned
Chromium and the isolated collaboration service, extending the same gate with
browser-backed tests.

```sh
devenv test                    # portable verification gate
devenv --profile browser test  # portable gate plus browser-backed tests
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

Start PostgreSQL and create the first server administrator once. `devenv up`
then serves the Admin Web app at `http://127.0.0.1:4174` and the Neoseq client at
`http://127.0.0.1:4173`. Further accounts are created and managed in the Admin
Web app; users sign in to the client with their username and password.

```sh
set -x DATABASE_URL "postgresql:///neoseq?host=$PGHOST"
cargo run -p sync-server -- bootstrap-admin admin
```

`issue-token`, `create-graph`, `grant`, and `revoke` remain explicit development
and recovery commands. Production account administration does not depend on
them, and production service processes should not set `NEOSEQ_TEST_AUTH_SECRET`.
Deploy `outputs.admin` on a private TLS-protected origin and route that origin's
`/v1` requests to the sync server; the browser never needs direct database
access.

## License

Copyright (C) 2026 Wonung Kim.

Except where otherwise noted, Neoseq is licensed under the GNU Affero General
Public License version 3 only. See [LICENSE](LICENSE). Third-party components
retain their respective licenses as described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
