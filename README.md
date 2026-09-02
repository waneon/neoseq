# Neoseq

Neoseq is a local-first outliner inspired by Logseq. It aims to be lightweight,
fast, and hassle-free.

## Quick start

Run the whole stack — the Web client, the synchronization server, and its
PostgreSQL database — as one container:

```sh
docker run -d --name neoseq \
  --stop-timeout 60 \
  -p 8080:8080 -p 8081:8081 \
  -v neoseq-data:/var/lib/neoseq \
  -v neoseq-backups:/backups \
  waneon/neoseq
```

Open `http://<host>:8080` from any device on your network. Graphs created there
stay in that browser until you connect the server: press `+` beside the
**Local** tab, sign in, and create or import a graph in the account's tab. The
same graph opened from another browser stays in sync.

The administration dashboard is on port `8081`. It creates accounts, resets
passwords, and revokes sessions. The server starts with one administrator,
`admin` with the password `change-me-later`; reset that password before anyone
else can reach the server.

Everything the server stores lives in the `neoseq-data` volume. If no named
volume is supplied, Docker creates an anonymous one that is easy to orphan when
the container is replaced. Plain HTTP is enough on a private network. Before
exposing the server beyond it, put a TLS-terminating reverse proxy in front of
both ports.

Persistent configuration, secret files, an external database, and a backup
mount are shown in [`examples/compose.yaml`](examples/compose.yaml).

### Backups

The database is the server's only durable state. Write a logical backup into the
separately mounted `/backups` volume:

```sh
docker exec neoseq neoseq-appliance backup /backups/neoseq-$(date +%F).dump
```

Restoring replaces the database and runs only against a stopped appliance.
Start the image once with the same volumes, the confirmation variable, and the
`restore` command:

```sh
docker stop neoseq
docker run --rm \
  -v neoseq-data:/var/lib/neoseq -v neoseq-backups:/backups \
  -e NEOSEQ_RESTORE_CONFIRM=replace-neoseq-data \
  waneon/neoseq restore /backups/neoseq-2026-09-02.dump
docker start neoseq
```

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
