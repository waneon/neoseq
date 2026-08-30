# Neoseq

Neoseq is a local-first outliner inspired by Logseq. It aims to be lightweight,
fast, and hassle-free.

## Quick start

Run Neoseq with the following command:

```sh
docker run -p 8080:8080 -p 8081:8081 waneon/neoseq
```

The Neoseq Docker container runs the entire application stack, including the
synchronization server and PostgreSQL. The Neoseq application is available on
port `8080`, and the administration dashboard is available on port `8081`.

By default, an `admin` account is created with the password `change-me-later`.

For more detailed Docker configuration, see
[`examples/compose.yaml`](examples/compose.yaml).

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

## License

Copyright (C) 2026 Wonung Kim.

Except where otherwise noted, Neoseq is licensed under the GNU Affero General
Public License version 3 only. See [LICENSE](LICENSE). Third-party components
retain their respective licenses as described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
