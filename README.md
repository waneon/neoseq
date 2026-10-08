# Neoseq

Neoseq is a local-first outliner inspired by Logseq. It aims to be lightweight,
fast, and hassle-free.

## Quick start

Run the whole stack — the Web client, the synchronization server, and its
PostgreSQL database — as one container:

```sh
docker run -d --name neoseq \
  -p 8080:8080 -p 8081:8081 \
  -v neoseq-data:/var/lib/neoseq \
  -v neoseq-backups:/backups \
  waneon/neoseq
```

Open `http://<host>:8080` from any device on your network.

The administration dashboard is on port `8081`. The server starts with one administrator,
`admin` with the password `change-me-later`; reset that password before anyone
else can reach the server.

Persistent configuration, secret files, an external database, and a backup
mount are shown in [`examples/compose.yaml`](examples/compose.yaml).

## Development

Enter the development shell with the following command.

```sh
devenv shell
```

Format all maintained codes with the following command.

```sh
treefmt
```

Start the development Web client with Hot Module Replacement (HMR), then open
`http://127.0.0.1:4173`.

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

## License

Copyright (C) 2026 Wonung Kim.

Except where otherwise noted, Neoseq is licensed under the GNU Affero General
Public License version 3 only. See [LICENSE](LICENSE). Third-party components
retain their respective licenses as described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
